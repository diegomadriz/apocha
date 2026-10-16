// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { digestBetweenCommits } from "../src/git/candidate.mjs";
import { readReceipt, verifyReceipt } from "../src/git/receipts.mjs";
import { runPromoteStage } from "../src/stages/promote.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testTempDir,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const BATCH = "refs/heads/apocha/batch/guards";
const NOTES = "refs/notes/apocha";

/** @param {string} root
 * @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer
 * @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer]
 */
function run(root, implementer, reviewer = passReviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return startRun({
    cwd: root,
    base: "main",
    batch: "guards",
    message: "Guard fixture",
    runtimes: fakeRuntimes(),
    task: valueTask({ max_repair_attempts: 0 }),
    adapters: { implementer: fake, reviewer: fake },
  });
}

/** @param {string} root @param {Awaited<ReturnType<typeof startRun>>} summary */
function assertUnpromoted(root, summary) {
  assert.notEqual(summary.outcome, "PASSED");
  assert.equal(summary.promoted_head, null);
  assert.equal(resolveCommit(root, BATCH), null);
  assert.equal(resolveCommit(root, NOTES), null, "no receipt notes were written");
}

// src/stages/review.mjs: a review must name the verified candidate digest.
test("review refuses a different candidate digest", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, writeValue(2), async ({ call }) => {
    await call("submit_result", {
      decision: "PASS",
      findings: [],
      candidate_digest: "0".repeat(64),
    });
  });
  assert.equal(summary.outcome, "ESCALATED");
  assert.match(summary.reason ?? "", /different candidate digest/);
  assertUnpromoted(repo.root, summary);
});

// src/stages/review.mjs: FIX requires at least one finding.
test("review refuses FIX without findings", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, writeValue(2), async ({ bundle, call }) => {
    await call("submit_result", {
      decision: "FIX",
      findings: [],
      candidate_digest: bundle.candidate.candidate_digest,
    });
  });
  assert.equal(summary.outcome, "ESCALATED");
  assert.match(summary.reason ?? "", /FIX without findings/);
  assertUnpromoted(repo.root, summary);
});

// src/stages/review.mjs: ESCALATE requires a reason.
test("review refuses ESCALATE without a reason", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, writeValue(2), async ({ bundle, call }) => {
    await call("submit_result", {
      decision: "ESCALATE",
      findings: [],
      candidate_digest: bundle.candidate.candidate_digest,
    });
  });
  assert.match(summary.reason ?? "", /ESCALATE without a reason/);
  assertUnpromoted(repo.root, summary);
});

// src/stages/review.mjs: re-snapshot after the reviewer returns.
test("review detects a candidate changed by the reviewer", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, writeValue(2), async (context) => {
    writeFileSync(path.join(context.root, "src/value.txt"), "3\n");
    await passReviewer(context);
  });
  assert.equal(summary.code, "candidate_changed_in_review");
  assertUnpromoted(repo.root, summary);
});

// src/stages/checks.mjs: post-check identity must match the pre-check snapshot.
test("checks detect candidate changes made while a check runs", async () => {
  const temporary = testTempDir("guard-check");
  const rootFile = path.join(temporary, "candidate-root");
  const script = path.join(temporary, "mutate.mjs");
  writeFileSync(
    script,
    'import { appendFileSync, readFileSync } from "node:fs";\n' +
      'import path from "node:path";\n' +
      'const root = readFileSync(process.argv[2], "utf8");\n' +
      'appendFileSync(path.join(root, "src/value.txt"), "changed during checks\\n");\n',
  );
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { test: { run: ["node", script, rootFile], cwd: "." } },
      default_checks: ["test"],
      sandbox: { mode: "none" },
    },
  });
  const summary = await run(repo.root, async (context) => {
    writeFileSync(rootFile, context.root);
    await writeValue(2)(context);
  });
  const state = new RunStore(repo.root).read(summary.run_id).state;
  assert.equal(state.last_verification.status, "violation");
  assert.deepEqual(
    state.last_verification.checks.find((check) => check.id === "post-check-identity"),
    { id: "post-check-identity", status: "fail", error: "candidate changed while checks ran" },
  );
  assertUnpromoted(repo.root, summary);
});

// src/stages/invoke.mjs: policy violations override an already submitted result.
test("a submitted result does not excuse a runtime policy violation", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, async (context) => {
    await writeValue(2)(context);
    throw new HarnessError("policy_violation", "forbidden_capability", "runtime violated policy");
  });
  assert.equal(summary.outcome, "ESCALATED");
  assert.equal(summary.error_class, "policy_violation");
  assert.equal(summary.code, "forbidden_capability");
  const record = new RunStore(repo.root).read(summary.run_id);
  assert.equal(record.state.implementation, null, "submitted implementation was discarded");
  const sessions = path.join(new RunStore(repo.root).dir(summary.run_id), "sessions");
  // The result really was submitted before the adapter failed.
  assert.match(readFileSync(path.join(sessions, "001", "tools.jsonl"), "utf8"), /submit_result/);
  assertUnpromoted(repo.root, summary);
});

// src/stages/promote.mjs: reject non-PASS reviews and non-passing catalog checks.
test("promotion refuses unreviewed states and checks that did not pass", async () => {
  const repo = makeRepo();
  // These inconsistent states cannot reach promotion through the workflow.
  const digest = "a".repeat(64);
  for (const [decision, status, code] of [
    ["FIX", "pass", "unreviewed"],
    ["PASS", "fail", "check_not_passed"],
  ]) {
    const ctx = /** @type {any} */ ({
      state: {
        last_verification: {
          status: "pass",
          candidate_digest: digest,
          checks: [{ id: "test", status, definition_digest: digest, sandbox: "none" }],
        },
        last_review: { decision, candidate_digest: digest, findings: [] },
      },
    });
    await assert.rejects(
      runPromoteStage({ kind: "promote" }, ctx),
      (error) => error instanceof HarnessError && error.code === code,
    );
    assert.equal(ctx.state.promotion, undefined);
    assert.equal(resolveCommit(repo.root, BATCH), null);
    assert.equal(resolveCommit(repo.root, NOTES), null);
  }
});

// src/git/receipts.mjs: base_commit must equal the commit's first parent.
test("receipt verification refuses a base other than the first parent", async () => {
  const repo = makeRepo();
  const summary = await run(repo.root, writeValue(2));
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  const head = /** @type {string} */ (summary.promoted_head);
  assert.equal(verifyReceipt(repo.root, NOTES, head).valid, true);
  const receipt = readReceipt(repo.root, NOTES, head);
  receipt.base_commit = head;
  // Keep the digest consistent with the forged base to isolate the parent guard.
  receipt.candidate_digest = digestBetweenCommits(repo.root, head, head);
  git(repo.root, ["notes", `--ref=${NOTES}`, "add", "-f", "-m", JSON.stringify(receipt), head]);
  const result = verifyReceipt(repo.root, NOTES, head);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "base_commit is not the first parent");
});
