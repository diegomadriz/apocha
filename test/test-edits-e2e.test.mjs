// @ts-check
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { isTestPath, normalizeProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { git } from "../src/util/git.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const original =
  'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("original", () => assert.equal(2, 2));\n';
const addition = 'test("added", () => assert.equal(3, 3));\n';
const rewritten = original.replace("assert.equal(2, 2)", "assert.ok(true)");

/** @param {string} root @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {Record<string, unknown>} [task] @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer] */
function run(root, implementer, task = {}, reviewer = passReviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return startRun({
    cwd: root,
    base: "main",
    batch: "test-policy",
    message: "Exercise test policy",
    runtimes: fakeRuntimes(),
    task: valueTask({
      allowed_paths: ["test/"],
      checks: ["ok"],
      max_repair_attempts: 0,
      ...task,
    }),
    adapters: { implementer: fake, reviewer: fake },
  });
}

/** @param {string} root @param {string} runId */
function traces(root, runId) {
  const sessions = path.join(new RunStore(root).dir(runId), "sessions");
  return readdirSync(sessions).flatMap((session) =>
    readFileSync(path.join(sessions, session, "tools.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

test("additive permits existing test cases and new tests, recording both in the receipt", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [
            { path: "test/existing.test.mjs", old_text: original, new_text: original + addition },
            { path: "test/new.test.mjs", old_text: "", new_text: original },
          ],
        });
        await call("submit_result", { summary: "Added test cases" });
      },
      {},
      async (context) => {
        assert.deepEqual(context.bundle.added_tests, ["test/new.test.mjs"]);
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        reviewed = true;
        await passReviewer(context);
      },
    );
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "pass"));
    const head = /** @type {string} */ (summary.promoted_head);
    const verified = verifyReceipt(repo.root, "refs/notes/apocha", head);
    assert.equal(verified.valid, true, verified.reason ?? "");
    assert.deepEqual(verified.receipt.tests, {
      policy: "additive",
      added: ["test/new.test.mjs"],
      modified: ["test/existing.test.mjs"],
    });
    // Older v3 notes without test metadata continue to verify.
    delete verified.receipt.tests;
    git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", head], {
      input: JSON.stringify(verified.receipt),
    });
    assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head).valid, true);
  } finally {
    repo.cleanup();
  }
});

test("reviewer rejects an additive early return that passes test-edits", async () => {
  const existing =
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("original", () => {\n  assert.equal(2, 2);\n});\n';
  const weakened = existing.replace("  assert.equal(2, 2);", "  return;\n  assert.equal(2, 2);");
  const repo = makeRepo({ files: { "test/existing.test.mjs": existing } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [{ path: "test/existing.test.mjs", old_text: existing, new_text: weakened }],
          // Preserve the matched text so the tool sees a pure addition.
          ...{
            edits: [
              {
                path: "test/existing.test.mjs",
                old_text: "  assert.equal(2, 2);",
                new_text: "  return;\n  assert.equal(2, 2);",
              },
            ],
          },
        });
        await call("submit_result", { summary: "Added early return" });
      },
      {},
      async (context) => {
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        assert.match(context.bundle.diff, /\+  return;/);
        reviewed = true;
        await context.call("submit_result", {
          decision: "FIX",
          candidate_digest: context.bundle.candidate.candidate_digest,
          findings: [
            {
              id: "early-return",
              path: "test/existing.test.mjs",
              reason: "The added early return bypasses the existing assertion.",
            },
          ],
        });
      },
    );
    assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "pass"));
    assert.notEqual(summary.outcome, "PASSED");
    const state = new RunStore(repo.root).read(summary.run_id);
    assert.equal(state.state.last_review.decision, "FIX");
    assert.equal(state.state.last_review.findings[0].id, "early-return");
  } finally {
    repo.cleanup();
  }
});

test("additive rejects assertion rewrites through apply_patch and giving up cannot pass", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let refused = false;
    const summary = await run(repo.root, async ({ call }) => {
      await assert.rejects(
        call("apply_patch", {
          edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: rewritten }],
        }),
        /test_edits policy 'additive'.*test_edits to 'allowed'/,
      );
      refused = true;
      await call("submit_result", { summary: "Could not rewrite assertion" });
    });
    assert.equal(refused, true);
    assert.notEqual(summary.outcome, "PASSED");
    const trace = traces(repo.root, summary.run_id);
    assert.ok(trace.some((entry) => entry.tool === "apply_patch" && entry.error_code === "test_edit_policy"));
  } finally {
    repo.cleanup();
  }
});

test("a smuggled assertion rewrite fails the authoritative test-edits check", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    const summary = await run(repo.root, async ({ call, root }) => {
      writeFileSync(path.join(root, "test/existing.test.mjs"), rewritten);
      await call("submit_result", { summary: "Smuggled assertion change" });
    });
    assert.equal(summary.outcome, "FAILED", summary.reason ?? "");
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "fail"));
    const state = new RunStore(repo.root).read(summary.run_id);
    assert.deepEqual(state.state.last_verification.checks.find((check) => check.id === "test-edits").files, [
      "test/existing.test.mjs",
    ]);
  } finally {
    repo.cleanup();
  }
});

test("allowed permits assertion edits and identifies modified tests for review", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: rewritten }],
        });
        await call("submit_result", { summary: "Changed existing assertion" });
      },
      { test_edits: "allowed" },
      async (context) => {
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        assert.deepEqual(context.bundle.added_tests, []);
        reviewed = true;
        await passReviewer(context);
      },
    );
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.deepEqual(
      verifyReceipt(repo.root, "refs/notes/apocha", /** @type {string} */ (summary.promoted_head)).receipt
        .tests,
      {
        policy: "allowed",
        added: [],
        modified: ["test/existing.test.mjs"],
      },
    );
  } finally {
    repo.cleanup();
  }
});

test("new-files rejects even pure additions to existing tests", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let refused = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await assert.rejects(
          call("apply_patch", {
            edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: original + addition }],
          }),
          /test_edits policy 'new-files'/,
        );
        refused = true;
        await call("submit_result", { summary: "Could not add to existing test" });
      },
      { test_edits: "new-files" },
    );
    assert.equal(refused, true);
    assert.notEqual(summary.outcome, "PASSED");
    assert.ok(traces(repo.root, summary.run_id).some((entry) => entry.error_code === "test_edit_policy"));
  } finally {
    repo.cleanup();
  }
});

test("isTestPath uses defaults, directory prefixes, basename wildcards, and exact paths", () => {
  const defaults = normalizeProjectConfig({ version: 1, checks: {} }, "/fixture");
  assert.deepEqual(defaults.tests.paths, ["test/", "tests/", "__tests__/", "*.test.*", "*.spec.*"]);
  for (const file of ["test/a.mjs", "tests/nested/a", "__tests__/a", "src/a.test.mjs", "src/a.spec.js"]) {
    assert.equal(isTestPath(defaults, file), true, file);
  }
  assert.equal(isTestPath(defaults, "src/a.test.mjs/ordinary"), false);
  const custom = normalizeProjectConfig(
    {
      version: 1,
      checks: {},
      tests: { paths: ["qa/", "*.test.mjs", "*.spec.*", "special/check.mjs", "*[a].mjs"] },
    },
    "/fixture",
  );
  for (const file of [
    "qa/nested/test",
    "src/a.test.mjs",
    "src/a.spec.ts",
    "special/check.mjs",
    "src/x[a].mjs",
  ]) {
    assert.equal(isTestPath(custom, file), true, file);
  }
  for (const file of ["other/qa/a", "special/check.mjs.bak", "src/aXtest.mjs", "src/xa.mjs"]) {
    assert.equal(isTestPath(custom, file), false, file);
  }
  const disabled = normalizeProjectConfig({ version: 1, checks: {}, tests: { paths: [] } }, "/fixture");
  assert.equal(isTestPath(disabled, "test/a.test.mjs"), false);
  assert.notEqual(disabled.digest, defaults.digest);
  assert.equal(
    normalizeProjectConfig({ version: 1, checks: {}, tests: {} }, "/fixture").digest,
    defaults.digest,
  );
});
