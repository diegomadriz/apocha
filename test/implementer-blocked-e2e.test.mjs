// @ts-check
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { validateWorkflow } from "../src/core/workflow.mjs";
import integrate from "../src/workflows/integrate.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

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
  test(`blocked implementer escalates immediately (changed=${changed}, reason length=${reason.length})`, async () => {
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
        () => {
          reviews += 1;
        },
      );
      assert.equal(summary.outcome, "ESCALATED");
      assert.equal(summary.reason, `implementer reported blocked: ${reason}`.slice(0, 1000));
      assert.equal(summary.repairs, 0);
      assert.equal(implementations, 1);
      assert.equal(reviews, 0);
      const store = new RunStore(repo.root);
      const state = store.read(summary.run_id).state;
      assert.equal(state.implementation.status, "blocked");
      assert.equal(state.implementation.blocked_reason, reason);
      assert.equal(state.last_verification, null);
      assert.equal(state.last_review, null);
      assert.equal(
        readdirSync(store.dir(summary.run_id)).some((name) => name.startsWith("verification-")),
        false,
      );
      const events = store.events(summary.run_id);
      assert.equal(events.find((event) => event.type === "implementer.blocked")?.reason, reason);
      assert.equal(
        events.some(
          (event) => event.type === "stage.started" && ["verify", "review", "repair"].includes(event.stage),
        ),
        false,
      );
    } finally {
      repo.cleanup();
    }
  });
}

test("integrate routes blocked implementers to ESCALATED", () => {
  assert.equal(integrate.stages.implement.on.blocked, "ESCALATED");
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
