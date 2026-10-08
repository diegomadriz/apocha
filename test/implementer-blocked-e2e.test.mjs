// @ts-check
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { collectRunFacts } from "../src/analytics/collect.mjs";
import { computeAnalytics } from "../src/analytics/compute.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { validateWorkflow } from "../src/core/workflow.mjs";
import integrate from "../src/workflows/integrate.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

/** @param {string} root @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {import("../src/adapters/fake/index.mjs").FakeHandler} reviewer */
function run(root, implementer, reviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return startRun({
    cwd: root,
    base: "main",
    batch: "blocked-test",
    message: "Set value to 2",
    runtimes: fakeRuntimes(),
    task: valueTask(),
    adapters: { implementer: fake, reviewer: fake },
  });
}

for (const [changed, reason] of [
  [true, "check.mjs requires 2 but the task requires 3"],
  [false, "check.mjs requires editing a protected path"],
  [true, "check.mjs conflict: " + "x".repeat(1500)],
]) {
  test(`blocked confirmation (changed=${changed}, reason length=${reason.length})`, async () => {
    const repo = makeRepo();
    let reviews = 0;
    let implementations = 0;
    try {
      const summary = await run(
        repo.root,
        async ({ call }) => {
          implementations += 1;
          if (changed) {
            const current = await call("read_files", { paths: ["src/value.txt"] });
            await call("apply_patch", {
              edits: [{ path: "src/value.txt", old_text: current.files[0].content, new_text: "3\n" }],
            });
          }
          await call("submit_result", {
            summary: "Task conflicts with check",
            status: "blocked",
            blocked_reason: reason,
          });
        },
        async ({ bundle, call }) => {
          reviews += 1;
          assert.deepEqual(bundle.blocked_claim, {
            blocked_reason: reason,
            summary: "Task conflicts with check",
          });
          assert.equal(bundle.verification, null);
          assert.equal(bundle.task.task_id, "set-value");
          assert.deepEqual(bundle.acceptance_criteria, ["src/value.txt contains 2"]);
          assert.deepEqual(bundle.allowed_paths, ["src/"]);
          assert.ok(bundle.protected_paths.includes("AGENTS.md"));
          assert.equal(bundle.diff.length > 0, changed);
          await assert.rejects(call("apply_patch", { edits: [] }), /not available|not allowed|unknown/i);
          await call("submit_result", {
            decision: "ESCALATE",
            findings: [],
            reason: "check.mjs conflicts with the task",
            candidate_digest: bundle.candidate.candidate_digest,
          });
        },
      );
      assert.equal(summary.outcome, "ESCALATED");
      assert.equal(
        summary.reason,
        "implementer reported blocked; reviewer confirmed: check.mjs conflicts with the task",
      );
      assert.equal(summary.repairs, 0);
      assert.equal(implementations, 1);
      assert.equal(reviews, 1);
      const store = new RunStore(repo.root);
      const state = store.read(summary.run_id).state;
      assert.equal(state.implementation.status, "blocked");
      assert.equal(state.implementation.blocked_reason, reason);
      assert.equal(state.last_verification, null);
      assert.equal(state.last_review.decision, "ESCALATE");
      assert.equal(state.blocked_claims[0].confirmed, true);
      assert.equal(
        readdirSync(store.dir(summary.run_id)).some((name) => name.startsWith("verification-")),
        false,
      );
      const events = store.events(summary.run_id);
      assert.equal(events.find((event) => event.type === "blocked.confirmed")?.decision, "ESCALATE");
      assert.deepEqual(computeAnalytics(collectRunFacts(repo.root)).blocked, {
        runs: 1,
        reports: 1,
        confirmed: 1,
        rejected: 0,
      });
      assert.equal(events.find((event) => event.type === "implementer.blocked")?.reason, reason);
      assert.equal(
        events.some((event) => event.type === "stage.started" && ["verify", "repair"].includes(event.stage)),
        false,
      );
    } finally {
      repo.cleanup();
    }
  });
}

for (const decision of ["FIX", "PASS"]) {
  test(`reviewer ${decision} rejects blocked claim and repairs to PASS`, async () => {
    const repo = makeRepo();
    let implementations = 0;
    let reviews = 0;
    const finding = {
      id: "complete-value",
      path: "src/value.txt",
      reason: "Read src/value.txt and set it to 2.",
    };
    try {
      const summary = await run(
        repo.root,
        async ({ bundle, call, ...rest }) => {
          implementations += 1;
          if (implementations === 1) {
            await call("submit_result", {
              summary: "Unfinished",
              status: "blocked",
              blocked_reason: "My work is incomplete",
            });
            return;
          }
          assert.equal(bundle.attempt, 1);
          assert.equal(bundle.previous_summary, "Unfinished");
          assert.equal(bundle.findings[0].source, "review");
          if (decision === "FIX") assert.deepEqual(bundle.findings, [{ source: "review", ...finding }]);
          else assert.match(bundle.findings[0].reason, /not confirmed.*complete the task/);
          await writeValue(2)({ bundle, call, ...rest });
        },
        async ({ bundle, call, ...rest }) => {
          reviews += 1;
          if (!bundle.blocked_claim) return passReviewer({ bundle, call, ...rest });
          assert.equal(bundle.diff, "");
          assert.equal(bundle.verification, null);
          await call("submit_result", {
            decision,
            findings: decision === "FIX" ? [finding] : [],
            candidate_digest: bundle.candidate.candidate_digest,
          });
        },
      );
      assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
      assert.equal(summary.repairs, 1);
      assert.equal(implementations, 2);
      assert.equal(reviews, 2);
      const store = new RunStore(repo.root);
      const events = store.events(summary.run_id);
      assert.equal(events.find((event) => event.type === "blocked.rejected")?.decision, decision);
      assert.equal(
        events.some((event) => event.type === "blocked.confirmed"),
        false,
      );
      assert.equal(store.read(summary.run_id).state.blocked_claims[0].confirmed, false);
      assert.deepEqual(computeAnalytics(collectRunFacts(repo.root)).blocked, {
        runs: 1,
        reports: 1,
        confirmed: 0,
        rejected: 1,
      });
    } finally {
      repo.cleanup();
    }
  });
}

test("rejected blocked claim after failed verification exhausts the repair budget", async () => {
  const repo = makeRepo();
  let implementations = 0;
  try {
    const summary = await run(
      repo.root,
      async ({ bundle, call, ...rest }) => {
        implementations += 1;
        if (implementations === 1) return writeValue(3)({ bundle, call, ...rest });
        await call("submit_result", {
          summary: "Check fails",
          status: "blocked",
          blocked_reason: "test check fails",
        });
      },
      async ({ bundle, call }) => {
        assert.equal(bundle.verification.status, "fail");
        assert.ok(bundle.verification.checks.some((check) => check.id === "test" && check.status === "fail"));
        assert.match(bundle.diff, /\+3/);
        await call("submit_result", {
          decision: "FIX",
          findings: [{ id: "value", reason: "Set src/value.txt to 2." }],
          candidate_digest: bundle.candidate.candidate_digest,
        });
      },
    );
    assert.equal(summary.outcome, "ESCALATED");
    assert.match(summary.reason, /^repairs budget exhausted/);
    assert.equal(summary.repairs, 1);
    assert.equal(implementations, 2);
    const events = new RunStore(repo.root).events(summary.run_id);
    assert.equal(events.filter((event) => event.type === "verification.started").length, 1);
    assert.equal(events.filter((event) => event.type === "blocked.rejected").length, 1);
  } finally {
    repo.cleanup();
  }
});

test("integrate routes blocked implementers through reviewer confirmation", () => {
  const stage = integrate.stages[integrate.stages.implement.on.blocked];
  assert.equal(stage.kind, "review");
  assert.equal(stage.role, "reviewer");
  assert.equal(stage.mode, "blocked-claim");
  assert.deepEqual(stage.on, {
    PASS: "repair",
    FIX: "repair",
    ESCALATE: "ESCALATED",
    too_large: "ESCALATED",
  });
  assert.equal(validateWorkflow(integrate), integrate);
});

test("submit_result rejects invalid pairings and an explicit done result still passes", async () => {
  const repo = makeRepo();
  try {
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await assert.rejects(
          call("submit_result", { summary: "blocked", status: "blocked" }),
          /blocked_reason is required/,
        );
        await assert.rejects(
          call("submit_result", { summary: "done", status: "done", blocked_reason: "conflict" }),
          /result is invalid/,
        );
        await assert.rejects(
          call("submit_result", { summary: "default done", blocked_reason: "conflict" }),
          /result is invalid/,
        );
        await assert.rejects(
          call("submit_result", { summary: "blocked", status: "blocked", blocked_reason: "" }),
          /too short/,
        );
        await assert.rejects(
          call("submit_result", { summary: "blocked", status: "blocked", blocked_reason: "x".repeat(2001) }),
          /too long/,
        );
        const current = await call("read_files", { paths: ["src/value.txt"] });
        await call("apply_patch", {
          edits: [{ path: "src/value.txt", old_text: current.files[0].content, new_text: "2\n" }],
        });
        await call("submit_result", { summary: "Set value to 2", status: "done" });
      },
      passReviewer,
    );
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(summary.repairs, 0);
  } finally {
    repo.cleanup();
  }
});
