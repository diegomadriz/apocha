// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectRunFacts } from "../src/analytics/collect.mjs";
import { computeAnalytics, DEFINITIONS } from "../src/analytics/compute.mjs";
import { formatAnalyticsMarkdown, formatAnalyticsText } from "../src/analytics/report.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { roleProvider } from "../src/config/runtime.mjs";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const requiredConfig = {
  version: 1,
  checks: { test: { run: ["node", "check.mjs"] } },
  sandbox: { mode: "none" },
  review: { require_independent: true },
};

function options(root, runtimes = fakeRuntimes()) {
  return {
    cwd: root,
    base: "main",
    batch: "independence",
    message: "Set value",
    task: valueTask(),
    runtimes,
  };
}

function notIndependent(error) {
  assert.ok(error instanceof HarnessError);
  assert.equal(error.errorClass, "config");
  assert.equal(error.code, "reviewer_not_independent");
  assert.match(error.message, /implementer provider=fake, reviewer provider=fake/);
  return true;
}

test("role providers normalize vendors and Pi adapter defaults before invocation", () => {
  assert.equal(roleProvider({ adapter: "codex" }), "openai");
  assert.equal(roleProvider({ adapter: "claude-code" }), "anthropic");
  assert.equal(roleProvider({ adapter: "fake" }), "fake");
  for (const provider of ["openai-codex", "openai", "anthropic", "google"]) {
    assert.equal(
      roleProvider({ adapter: "pi", provider }),
      provider === "openai-codex" ? "openai" : provider,
    );
  }
  assert.equal(roleProvider({ adapter: "pi" }, { provider: "openai-codex" }), "openai");
  assert.equal(roleProvider({ adapter: "pi", provider: "anthropic" }, { provider: "openai" }), "anthropic");
  assert.equal(normalizeProjectConfig({ version: 1, checks: {} }, ".").review.require_independent, false);
});

test("controller writes same-provider receipt and older receipts still verify", async () => {
  const repo = makeRepo();
  try {
    const fake = createFakeAdapter({ handlers: { implementer: writeValue(2), reviewer: passReviewer } });
    const summary = await startRun({
      ...options(repo.root),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const commit = /** @type {string} */ (summary.promoted_head);
    const verified = verifyReceipt(repo.root, "refs/notes/apocha", commit);
    assert.equal(verified.valid, true);
    assert.deepEqual(verified.receipt.review_independence, {
      implementer_provider: "fake",
      reviewer_provider: "fake",
      independent: false,
    });
    assert.deepEqual(computeAnalytics(collectRunFacts(repo.root)).review_independence, {
      independent: 0,
      same_provider: 1,
      unknown: 0,
    });
    delete verified.receipt.review_independence;
    git(repo.root, [
      "notes",
      "--ref=refs/notes/apocha",
      "add",
      "-f",
      "-m",
      JSON.stringify(verified.receipt),
      commit,
    ]);
    assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", commit).valid, true);
  } finally {
    repo.cleanup();
  }
});

test("required independence uses base config and refuses before agents or RUNNING records", async () => {
  const repo = makeRepo({ config: requiredConfig });
  try {
    writeFileSync(
      path.join(repo.root, "apocha.config.json"),
      JSON.stringify({ ...requiredConfig, review: { require_independent: false } }),
    );
    let calls = 0;
    const fake = createFakeAdapter({
      handlers: {
        implementer: async () => {
          calls += 1;
        },
        reviewer: passReviewer,
      },
    });
    await assert.rejects(
      startRun({ ...options(repo.root), adapters: { implementer: fake, reviewer: fake } }),
      notIndependent,
    );
    assert.equal(calls, 0);
    assert.deepEqual(new RunStore(repo.root).list(), []);
    assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/independence"), null);
  } finally {
    repo.cleanup();
  }
});

test("resume refuses same-provider replacement and preserves the paused run", async () => {
  const repo = makeRepo({ config: requiredConfig });
  try {
    const independent = fakeRuntimes({
      roles: {
        implementer: { adapter: "fake" },
        reviewer: { adapter: "pi", model: "test", provider: "anthropic" },
      },
    });
    let reviewerCalls = 0;
    const fake = createFakeAdapter({
      handlers: {
        implementer: async () => {
          throw new HarnessError("usage_limited", "limit", "usage limit");
        },
        reviewer: async () => {
          reviewerCalls += 1;
        },
      },
    });
    const paused = await startRun({
      ...options(repo.root, independent),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(paused.outcome, "PAUSED");
    const store = new RunStore(repo.root);
    const before = store.read(paused.run_id);
    await assert.rejects(
      resumeRun({ cwd: repo.root, runId: paused.run_id, runtimes: fakeRuntimes() }),
      notIndependent,
    );
    assert.deepEqual(store.read(paused.run_id), before);
    assert.equal(reviewerCalls, 0);
  } finally {
    repo.cleanup();
  }
});

test("real doctor CLI warns for same-provider roles and reports required policy", () => {
  for (const required of [false, true]) {
    const repo = makeRepo({ config: { ...requiredConfig, review: { require_independent: required } } });
    try {
      const runtimes = path.join(repo.root, "runtimes.json");
      writeFileSync(
        runtimes,
        JSON.stringify({
          version: 1,
          roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)), "doctor", "--runtimes", runtimes],
        { cwd: repo.root, encoding: "utf8" },
      );
      assert.equal(result.status, required ? 20 : 0, result.stderr);
      assert.match(result.stdout, /warning: same-provider review; implementer=fake, reviewer=fake/);
      assert.ok(result.stdout.includes(required ? "; required" : "; optional"));
    } finally {
      repo.cleanup();
    }
  }
});

test("analytics counts recorded independent, same-provider, and unknown runs in all formats", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    for (const [index, reviewer] of [
      { adapter: "pi", provider: "anthropic" },
      { adapter: "pi", provider: "openai-codex" },
      null,
    ].entries()) {
      const id = `independence-20260101T000000Z-000${index}`;
      store.create(id, { task_id: "independence", workflow: "code-delivery" });
      store.update(id, {
        outcome: "PASSED",
        state: { runtimes: { implementer: { adapter: "codex" }, reviewer } },
      });
    }
    const analytics = computeAnalytics(collectRunFacts(repo.root));
    assert.deepEqual(analytics.review_independence, { independent: 1, same_provider: 1, unknown: 1 });
    assert.match(
      formatAnalyticsText(analytics),
      /review independence: independent=1, same-provider=1, unknown=1/,
    );
    assert.match(formatAnalyticsMarkdown(analytics, { definitions: DEFINITIONS }), /## Review independence/);
  } finally {
    repo.cleanup();
  }
});
