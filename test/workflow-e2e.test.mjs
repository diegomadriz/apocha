// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { computeMetrics } from "../src/core/metrics.mjs";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { landBranch } from "../src/git/land.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, gitText, resolveCommit } from "../src/util/git.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask, writeValue } from "./helpers.mjs";

/** @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer] */
function adapters(implementer, reviewer = passReviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return { implementer: fake, reviewer: fake };
}

const base = (root, extra = {}) => ({
  cwd: root,
  base: "main",
  batch: "set-value",
  message: "Set value to 2",
  runtimes: fakeRuntimes(),
  ...extra,
});

test("a failed batch reservation leaves no RUNNING record", async () => {
  const repo = makeRepo();
  try {
    git(repo.root, ["update-ref", "refs/heads/panagent/batch/set-value", "main"]);
    await assert.rejects(
      startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(writeValue(2)) }),
      /batch|ref/,
    );
    assert.equal(new RunStore(repo.root).list().length, 0);
    assert.equal(
      resolveCommit(repo.root, "refs/heads/panagent/batch/set-value"),
      resolveCommit(repo.root, "main"),
    );
  } finally {
    repo.cleanup();
  }
});

test("aborting a fake adapter run records ERROR/infra/aborted", async () => {
  const repo = makeRepo();
  try {
    const controller = new AbortController();
    const implementer = async (context) => {
      await writeValue(2)(context);
      controller.abort();
    };
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask(),
      adapters: adapters(implementer),
      signal: controller.signal,
    });
    assert.equal(summary.outcome, "ERROR");
    assert.equal(summary.error_class, "infra");
    assert.equal(summary.code, "aborted");
    const run = new RunStore(repo.root).read(summary.run_id);
    assert.equal(run.outcome, "ERROR");
    assert.equal(run.error_class, "infra");
    assert.equal(run.code, "aborted");
    assert.equal(run.state.error.code, "aborted");
    assert.ok(run.finished_at);
    assert.equal(resolveCommit(repo.root, "refs/heads/panagent/batch/set-value"), null);
  } finally {
    repo.cleanup();
  }
});

test("a passing run promotes the candidate and writes a verifiable receipt", async () => {
  const repo = makeRepo();
  try {
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask(),
      adapters: adapters(writeValue(2)),
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(summary.repairs, 0);
    const head = resolveCommit(repo.root, "refs/heads/panagent/batch/set-value");
    assert.equal(head, summary.promoted_head);
    assert.equal(gitText(repo.root, ["show", `${head}:src/value.txt`]), "2");
    const receipt = verifyReceipt(repo.root, "refs/notes/panagent", /** @type {string} */ (head));
    assert.equal(receipt.valid, true, receipt.reason ?? "");
    assert.equal(receipt.version, 3);
    assert.equal(receipt.receipt.checks[0].id, "test");
    assert.equal(receipt.receipt.governance.edits_allowed, false);
    // land fast-forwards main onto the receipted batch head
    const landed = landBranch({
      repositoryRoot: repo.root,
      notesRef: "refs/notes/panagent",
      source: "panagent/batch/set-value",
      target: "main",
    });
    assert.equal(landed.commits.length, 1);
    assert.equal(resolveCommit(repo.root, "main"), head);
  } finally {
    repo.cleanup();
  }
});

test("a failing check is repaired with failure-first findings", async () => {
  const repo = makeRepo();
  try {
    const seen = [];
    const implementer = async (context) => {
      seen.push(context.bundle.findings);
      await writeValue(context.attempt === 0 ? 3 : 2)(context);
    };
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask(),
      adapters: adapters(implementer),
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(summary.repairs, 1);
    assert.equal(seen[1].length, 1);
    assert.match(seen[1][0].reason, /src\/value\.txt:1 expected 2, got 3/);
    assert.equal(seen[1][0].source, "verification");
  } finally {
    repo.cleanup();
  }
});

test("repair budget exhaustion escalates and releases the batch ref", async () => {
  const repo = makeRepo();
  try {
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask({ max_repair_attempts: 0 }),
      adapters: adapters(writeValue(3)),
    });
    assert.equal(summary.outcome, "ESCALATED");
    assert.match(summary.reason ?? "", /repairs budget exhausted/);
    assert.equal(resolveCommit(repo.root, "refs/heads/panagent/batch/set-value"), null);
    const run = new RunStore(repo.root).read(summary.run_id);
    assert.equal(run.outcome, "ESCALATED");
  } finally {
    repo.cleanup();
  }
});

test("reviewer FIX findings go back to the implementer", async () => {
  const repo = makeRepo();
  try {
    let reviews = 0;
    const reviewer = async ({ bundle, call }) => {
      reviews += 1;
      assert.match(bundle.diff, /src\/value\.txt/);
      const decision = reviews === 1 ? "FIX" : "PASS";
      const findings =
        reviews === 1
          ? [{ id: "add-note", reason: "also mention the change in README.md", path: "README.md" }]
          : [];
      await call("submit_result", {
        decision,
        findings,
        candidate_digest: bundle.candidate.candidate_digest,
      });
    };
    const implementer = async (context) => {
      if (context.attempt === 0) return writeValue(2)(context);
      assert.equal(context.bundle.findings[0].id, "add-note");
      const readme = await context.call("read_files", { paths: ["src/value.txt"] });
      await context.call("apply_patch", {
        edits: [{ path: "src/value.txt", old_text: readme.files[0].content, new_text: "2\n\n" }],
      });
      await context.call("submit_result", { summary: "addressed review" });
    };
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask(),
      adapters: adapters(implementer, reviewer),
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(summary.repairs, 1);
  } finally {
    repo.cleanup();
  }
});

test("the tools refuse paths outside allowed_paths", async () => {
  const repo = makeRepo();
  try {
    const implementer = async ({ call }) => {
      await assert.rejects(
        call("apply_patch", { edits: [{ path: "README.md", old_text: "# fixture\n", new_text: "x\n" }] }),
        /outside allowed_paths/,
      );
      await assert.rejects(call("read_files", { paths: ["private/secret.txt"] }), /not readable/);
      await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      await call("submit_result", { summary: "done" });
    };
    const summary = await startRun({
      ...base(repo.root),
      task: valueTask(),
      adapters: adapters(implementer),
    });
    assert.equal(summary.outcome, "PASSED");
  } finally {
    repo.cleanup();
  }
});

test("a change smuggled past the tools fails the structural checks", async () => {
  const repo = makeRepo();
  try {
    const escaped = async ({ call, root }) => {
      await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      writeFileSync(path.join(root, "README.md"), "changed outside the tools\n");
      await call("submit_result", { summary: "done" });
    };
    const summary = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(escaped) });
    assert.equal(summary.outcome, "FAILED");
    assert.deepEqual(
      summary.checks.find((check) => check.id === "allowed-scope"),
      { id: "allowed-scope", status: "fail" },
    );
  } finally {
    repo.cleanup();
  }
});

test("an implementer that never submits is retried once, then escalates", async () => {
  const repo = makeRepo();
  try {
    let calls = 0;
    const silent = async () => {
      calls += 1;
    };
    const summary = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(silent) });
    assert.equal(summary.outcome, "ESCALATED");
    assert.equal(calls, 2);
    assert.equal(summary.retries, 1);
    assert.match(summary.reason ?? "", /agent\/no_result/);
  } finally {
    repo.cleanup();
  }
});

test("a usage limit pauses the run and resume continues it", async () => {
  const repo = makeRepo();
  try {
    let limited = true;
    const implementer = async (context) => {
      if (limited)
        throw new HarnessError(
          "usage_limited",
          "limit",
          "You've hit your usage limit. Try again at 9:00 PM.",
          { retryAfter: "9:00 PM" },
        );
      await writeValue(2)(context);
    };
    const first = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(implementer) });
    assert.equal(first.outcome, "PAUSED");
    assert.match(first.reason ?? "", /retry after 9:00 PM/);
    assert.ok(
      resolveCommit(repo.root, "refs/heads/panagent/batch/set-value"),
      "batch ref stays reserved while paused",
    );
    limited = false;
    const second = await resumeRun({
      cwd: repo.root,
      runId: first.run_id,
      runtimes: fakeRuntimes(),
      adapters: adapters(implementer),
    });
    assert.equal(second.outcome, "PASSED", second.reason ?? "");
    const events = new RunStore(repo.root).events(first.run_id).map((event) => event.type);
    assert.ok(events.includes("run.paused") && events.includes("run.resumed"));
  } finally {
    repo.cleanup();
  }
});

test("a run cannot use the batch of a paused run as its base", async () => {
  const repo = makeRepo();
  try {
    const limited = async () => {
      throw new HarnessError("usage_limited", "limit", "usage limit reached");
    };
    const paused = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(limited) });
    assert.equal(paused.outcome, "PAUSED");
    await assert.rejects(
      startRun({
        ...base(repo.root, { base: "panagent/batch/set-value", batch: "chained" }),
        task: valueTask(),
        adapters: adapters(writeValue(2)),
      }),
      /has not finished/,
    );
  } finally {
    repo.cleanup();
  }
});

test("infra errors from the runtime are retried once and recorded", async () => {
  const repo = makeRepo();
  try {
    let calls = 0;
    const flaky = async (context) => {
      calls += 1;
      if (calls === 1) throw new HarnessError("infra", "timeout", "runtime timed out");
      await writeValue(2)(context);
    };
    const summary = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(flaky) });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(summary.retries, 1);
    const receipt = verifyReceipt(
      repo.root,
      "refs/notes/panagent",
      /** @type {string} */ (summary.promoted_head),
    );
    assert.equal(receipt.receipt.retries, 1);
  } finally {
    repo.cleanup();
  }
});

test("a policy violation escalates without retry", async () => {
  const repo = makeRepo();
  try {
    let calls = 0;
    const rogue = async () => {
      calls += 1;
      throw new HarnessError(
        "policy_violation",
        "foreign_tool",
        "runtime called a tool outside the harness: shell",
      );
    };
    const summary = await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(rogue) });
    assert.equal(summary.outcome, "ESCALATED");
    assert.equal(calls, 1);
    assert.equal(summary.error_class, "policy_violation");
  } finally {
    repo.cleanup();
  }
});

test("governance paths are protected unless edits are allowed with a reason", async () => {
  const repo = makeRepo({ files: { "AGENTS.md": "rules\n" } });
  try {
    const editRules = async ({ call }) => {
      const result = await call("apply_patch", {
        edits: [{ path: "AGENTS.md", old_text: "rules\n", new_text: "new rules\n" }],
      }).catch((error) => error);
      if (result instanceof Error) {
        await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      } else {
        await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      }
      await call("submit_result", { summary: "edited" });
    };
    const task = valueTask({ allowed_paths: ["src/", "AGENTS.md"] });
    const blocked = await startRun({ ...base(repo.root), task, adapters: adapters(editRules) });
    assert.equal(blocked.outcome, "PASSED");
    assert.equal(gitText(repo.root, ["show", `${blocked.promoted_head}:AGENTS.md`]), "rules");

    await assert.rejects(
      startRun({
        ...base(repo.root, { batch: "rules-2" }),
        task,
        adapters: adapters(editRules),
        allowGovernanceEdits: true,
      }),
      /--reason/,
    );
    const allowed = await startRun({
      ...base(repo.root, { batch: "rules-3" }),
      task,
      adapters: adapters(editRules),
      allowGovernanceEdits: true,
      governanceReason: "update agent rules",
    });
    assert.equal(allowed.outcome, "PASSED", allowed.reason ?? "");
    assert.equal(gitText(repo.root, ["show", `${allowed.promoted_head}:AGENTS.md`]), "new rules");
    const receipt = verifyReceipt(
      repo.root,
      "refs/notes/panagent",
      /** @type {string} */ (allowed.promoted_head),
    ).receipt;
    assert.deepEqual(receipt.governance, {
      edits_allowed: true,
      by: "Test User <test@example.invalid>",
      reason: "update agent rules",
    });
  } finally {
    repo.cleanup();
  }
});

test("integrate merges a topic, verifies, reviews, and promotes with two parents", async () => {
  const repo = makeRepo();
  try {
    git(repo.root, ["checkout", "-qb", "topic"]);
    writeFileSync(`${repo.root}/src/value.txt`, "2\n");
    git(repo.root, ["add", "-A"]);
    git(repo.root, ["commit", "-qm", "set value"]);
    git(repo.root, ["checkout", "-q", "main"]);
    writeFileSync(`${repo.root}/README.md`, "# fixture\nmore\n");
    git(repo.root, ["commit", "-qam", "main moves on"]);
    const topic = resolveCommit(repo.root, "topic");
    const summary = await startRun({
      cwd: repo.root,
      workflow: "integrate",
      base: "main",
      batch: "integrate-topic",
      message: "Integrate topic",
      runtimes: fakeRuntimes(),
      integration: { topic: "topic", checks: ["test"] },
      adapters: adapters(async () => {
        throw new Error("implementer must not run for a clean merge");
      }),
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const receipt = verifyReceipt(
      repo.root,
      "refs/notes/panagent",
      /** @type {string} */ (summary.promoted_head),
    );
    assert.equal(receipt.valid, true, receipt.reason ?? "");
    assert.equal(receipt.receipt.parents[1], topic);
    assert.equal(receipt.receipt.workflow, "integrate");
  } finally {
    repo.cleanup();
  }
});

test("metrics count every run, not only receipts", async () => {
  const repo = makeRepo();
  try {
    await startRun({ ...base(repo.root), task: valueTask(), adapters: adapters(writeValue(2)) });
    await startRun({
      ...base(repo.root, { batch: "second" }),
      task: valueTask({ max_repair_attempts: 0 }),
      adapters: adapters(writeValue(3)),
    });
    const metrics = computeMetrics(repo.root, { notesRef: "refs/notes/panagent" });
    assert.equal(metrics.runs.finished, 2);
    assert.equal(metrics.runs.first_attempt_pass_rate, 50);
    assert.equal(metrics.deliveries.deliveries, 1);
    assert.equal(metrics.deliveries.no_repair_rate, 100);
  } finally {
    repo.cleanup();
  }
});
