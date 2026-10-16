// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState } from "../src/core/context.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { runPromoteStage } from "../src/stages/promote.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { resolveCommit } from "../src/util/git.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, valueTask, writeValue } from "./helpers.mjs";

/** @param {string} root @param {{ id: string, reason: string, severity?: string }[]} findings */
function runWithFindings(root, findings) {
  const fake = createFakeAdapter({
    handlers: {
      implementer: writeValue(2),
      reviewer: async ({ bundle, call }) => {
        await call("submit_result", {
          decision: "PASS",
          findings,
          candidate_digest: bundle.candidate.candidate_digest,
        });
      },
    },
  });
  return startRun({
    cwd: root,
    base: "main",
    batch: "set-value",
    message: "Set value to 2",
    runtimes: fakeRuntimes(),
    task: valueTask(),
    adapters: { implementer: fake, reviewer: fake },
  });
}

test("PASS with a blocking finding escalates without promotion or a receipt", async () => {
  const repo = makeRepo();
  try {
    const summary = await runWithFindings(repo.root, [
      { id: "minor-first", reason: "Optional improvement", severity: "minor" },
      { id: "blocking", reason: "Required correction", severity: "blocking" },
    ]);
    const reason = "invalid review: PASS with a blocking finding";
    assert.equal(summary.outcome, "ESCALATED");
    assert.equal(summary.reason, reason);
    assert.equal(summary.promoted_head, null);
    assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/set-value"), null);
    assert.equal(resolveCommit(repo.root, "refs/notes/apocha"), null);
    const store = new RunStore(repo.root);
    const run = store.read(summary.run_id);
    assert.equal(run.state.promotion, null);
    assert.deepEqual(run.state.last_review, {
      decision: "ESCALATE",
      findings: [],
      reason,
      candidate_digest: run.state.last_verification.candidate_digest,
    });
    const event = store.events(summary.run_id).find((entry) => entry.type === "review.finished");
    assert.ok(event);
    assert.equal(event.decision, "ESCALATE");
    assert.equal(event.invalid, "PASS with a blocking finding");
  } finally {
    repo.cleanup();
  }
});

for (const severity of ["minor", undefined]) {
  test(`PASS with a ${severity ?? "severity-free"} finding promotes with a receipt`, async () => {
    const repo = makeRepo();
    try {
      const summary = await runWithFindings(repo.root, [
        { id: "optional", reason: "Optional improvement", ...(severity ? { severity } : {}) },
      ]);
      assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
      const head = resolveCommit(repo.root, "refs/heads/apocha/batch/set-value");
      assert.ok(head);
      assert.equal(head, summary.promoted_head);
      const receipt = verifyReceipt(repo.root, "refs/notes/apocha", head);
      assert.equal(receipt.valid, true, receipt.reason ?? "");
      assert.equal(receipt.receipt.review.decision, "PASS");
      assert.equal(receipt.receipt.review.findings, 1);
    } finally {
      repo.cleanup();
    }
  });
}

test("promotion rejects a stored PASS with a blocking finding before taking the lock", async () => {
  const state = initialState("promote");
  state.last_verification = {
    status: "pass",
    candidate_digest: "a".repeat(64),
    checks: [],
    changed_files: [],
  };
  state.last_review = {
    decision: "PASS",
    candidate_digest: state.last_verification.candidate_digest,
    findings: [{ id: "blocking", reason: "Required correction", severity: "blocking" }],
  };
  // The guard needs only persisted state; any attempt to use promotion resources fails.
  const ctx = /** @type {import("../src/core/context.mjs").RunContext} */ (
    /** @type {unknown} */ ({
      state,
      get stateDir() {
        return assert.fail("promotion must reject before taking the lock");
      },
    })
  );
  await assert.rejects(
    runPromoteStage({ kind: "promote", on: { done: "PASSED" } }, ctx),
    (error) =>
      error instanceof HarnessError && error.errorClass === "integrity" && error.code === "unreviewed",
  );
});
