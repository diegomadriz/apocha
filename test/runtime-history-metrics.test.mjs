// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics } from "../src/core/metrics.mjs";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

for (const mode of ["changed", "unchanged", "returned"]) {
  test(`runtime config history survives ${mode} resumes and verifies in receipts`, async () => {
    const repo = makeRepo();
    try {
      const initial = fakeRuntimes();
      const changed = fakeRuntimes({ budgets: { timeout_ms: 60000, max_tool_calls: 60 } });
      assert.notEqual(initial.digest, changed.digest);
      const limited = async () => {
        throw new HarnessError("usage_limited", "limit", "usage limit reached");
      };
      const fake = createFakeAdapter({ handlers: { implementer: limited, reviewer: passReviewer } });
      const first = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "set-value",
        message: "Set value to 2",
        task: valueTask(),
        runtimes: initial,
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(first.outcome, "PAUSED");
      const store = new RunStore(repo.root);
      assert.deepEqual(store.read(first.run_id).runtime_config_digests, [initial.digest]);
      const configs =
        mode === "unchanged" ? [initial] : mode === "changed" ? [changed] : [changed, changed, initial];
      const history = [initial.digest];
      for (const [index, runtimes] of configs.entries()) {
        const last = index === configs.length - 1;
        const adapter = createFakeAdapter({
          handlers: { implementer: last ? writeValue(2) : limited, reviewer: passReviewer },
        });
        const summary = await resumeRun({
          cwd: repo.root,
          runId: first.run_id,
          runtimes,
          adapters: { implementer: adapter, reviewer: adapter },
        });
        assert.equal(summary.outcome, last ? "PASSED" : "PAUSED", summary.reason ?? "");
        if (history.at(-1) !== runtimes.digest) history.push(runtimes.digest);
        const record = store.read(first.run_id);
        assert.deepEqual(record.runtime_config_digests, history);
        assert.equal(record.runtime_config_digest, initial.digest);
        if (last) {
          const receipt = verifyReceipt(
            repo.root,
            "refs/notes/apocha",
            /** @type {string} */ (summary.promoted_head),
          );
          assert.equal(receipt.valid, true, receipt.reason ?? "");
          assert.equal(receipt.receipt.runtime_config_digest, runtimes.digest);
          if (mode === "unchanged")
            assert.equal(Object.hasOwn(receipt.receipt, "runtime_config_digests"), false);
          else assert.deepEqual(receipt.receipt.runtime_config_digests, history);
        }
      }
      const active = [initial.digest, ...configs.map((config) => config.digest), configs.at(-1)?.digest];
      for (const type of ["agent.started", "agent.finished"]) {
        assert.deepEqual(
          store
            .events(first.run_id)
            .filter((event) => event.type === type)
            .map((event) => event.runtime_config_digest),
          active,
        );
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("metrics bucket invalid repair counts from raw notes as unknown", () => {
  const repo = makeRepo();
  try {
    const notesRef = "refs/notes/apocha";
    for (const repairs of [0, 2, 5, -1, "x"]) {
      git(repo.root, ["commit", "--allow-empty", "-qm", `repairs ${repairs}`]);
      git(repo.root, ["notes", `--ref=${notesRef}`, "add", "-m", JSON.stringify({ repairs }), "HEAD"]);
    }
    const metrics = computeMetrics(repo.root, { notesRef });
    assert.equal(metrics.deliveries.deliveries, 5);
    assert.deepEqual(metrics.deliveries.repairs, { 0: 1, 1: 0, 2: 1, unknown: 3 });
    assert.equal(metrics.deliveries.no_repair_rate, 20);
    assert.equal(metrics.deliveries.within_one_repair_rate, 20);
    assert.match(metrics.definitions.delivery_repairs, /unknown/);
  } finally {
    repo.cleanup();
  }
});

test("metrics handle missing, fractional, wrongly typed, and legacy repair counts", () => {
  const repo = makeRepo();
  try {
    const notesRef = "refs/notes/apocha";
    const receipts = [
      {},
      { repairs: 0.5 },
      { repairs: "0" },
      { repairs: null, repair_attempts: 0 },
      { repairs: false },
      { repair_attempts: 1 },
    ];
    for (const [index, receipt] of receipts.entries()) {
      git(repo.root, ["commit", "--allow-empty", "-qm", `receipt ${index}`]);
      git(repo.root, ["notes", `--ref=${notesRef}`, "add", "-m", JSON.stringify(receipt), "HEAD"]);
    }
    assert.deepEqual(computeMetrics(repo.root, { notesRef }).deliveries.repairs, {
      0: 0,
      1: 1,
      2: 0,
      unknown: 5,
    });
  } finally {
    repo.cleanup();
  }
});
