// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initialState } from "../src/core/context.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { runPromoteStage } from "../src/stages/promote.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, valueTask } from "./helpers.mjs";

const judgePath = "src/biome.json";
const before = '{"linter":{"enabled":true}}\n';
const after = '{"linter":{"enabled":true},"formatter":{"enabled":true}}\n';
const declaration = {
  path: judgePath,
  kind: "fix",
  reason: "Enable formatting for the task while keeping lint enabled.",
};
const justified = {
  path: judgePath,
  verdict: "justified",
  reason: "Formatting is required by the task and does not relax lint.",
};

/** @param {Record<string, any>} result @param {string} [kind] */
async function runChange(result, kind = "fix", repair = false) {
  const repo = makeRepo({ files: { [judgePath]: before } });
  const bundles = [];
  let implementations = 0;
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call }) => {
        implementations++;
        const current = await call("read_files", { paths: ["src/value.txt", judgePath] });
        if (implementations === 1)
          await call("apply_patch", {
            edits: [
              { path: "src/value.txt", old_text: current.files[0].content, new_text: "2\n" },
              { path: judgePath, old_text: current.files[1].content, new_text: after },
            ],
          });
        await call("submit_result", {
          summary: "Set value and enable formatting.",
          judge_input_changes: [{ ...declaration, kind }],
        });
      },
      reviewer: async ({ bundle, call }) => {
        bundles.push(bundle);
        await call("submit_result", {
          candidate_digest: bundle.candidate.candidate_digest,
          findings: [],
          ...(repair && bundles.length > 1
            ? { decision: "PASS", judge_input_verdicts: [justified] }
            : result),
        });
      },
    },
  });
  const summary = await startRun({
    cwd: repo.root,
    base: "main",
    batch: "set-value",
    message: "Set value and enable formatting",
    runtimes: fakeRuntimes(),
    task: valueTask({
      description: "Set value to 2 and enable formatting without relaxing lint.",
    }),
    adapters: { implementer: fake, reviewer: fake },
  });
  return { repo, summary, bundles, implementations, store: new RunStore(repo.root) };
}

for (const [name, verdicts] of [
  ["missing", undefined],
  ["unjustified", [{ ...justified, verdict: "unjustified" }]],
  ["different path", [{ ...justified, path: "src/other/biome.json" }]],
  ["duplicate", [justified, justified]],
  ["extra path", [justified, { ...justified, path: "src/other/biome.json" }]],
]) {
  test(`PASS with ${name} judge input verdicts is invalid and cannot promote`, async () => {
    const { repo, summary, store } = await runChange({
      decision: "PASS",
      ...(verdicts ? { judge_input_verdicts: verdicts } : {}),
    });
    try {
      const invalidPath = name === "extra path" ? "src/other/biome.json" : judgePath;
      const invalid = `PASS without a justified verdict for ${invalidPath}`;
      assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
      assert.equal(summary.reason, `invalid review: ${invalid}`);
      assert.equal(summary.promoted_head, null);
      assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/set-value"), null);
      assert.equal(resolveCommit(repo.root, "refs/notes/apocha"), null);
      const state = store.read(summary.run_id).state;
      assert.equal(state.last_review.decision, "ESCALATE");
      assert.equal(state.last_review.reason, summary.reason);
      assert.equal(state.promotion, null);
      const event = store.events(summary.run_id).find((entry) => entry.type === "review.finished");
      assert.equal(event.decision, "ESCALATE");
      assert.equal(event.invalid, invalid);
    } finally {
      repo.cleanup();
    }
  });
}

for (const kind of ["fix", "tighten"]) {
  test(`justified ${kind} declaration promotes with verifiable verdicts and review evidence`, async () => {
    const { repo, summary, store, bundles } = await runChange(
      {
        decision: "PASS",
        judge_input_verdicts: [justified],
      },
      kind,
    );
    try {
      assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
      const verification = store.read(summary.run_id).state.last_verification;
      const entry = bundles[0].judge_input_changes[0];
      assert.deepEqual(entry, {
        path: judgePath,
        change: "modified",
        kind,
        declared_by: "implementer",
        declared_reason: declaration.reason,
        diff: String(
          git(repo.root, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            bundles[0].candidate.base_commit,
            summary.promoted_head,
            "--",
            judgePath,
          ]).stdout,
        ),
      });
      assert.match(entry.diff, /-"?\{"linter"/);
      assert.ok(entry.diff.includes(after.trim()));
      assert.deepEqual(bundles[0].base_judge, verification.base_judge);
      assert.equal(bundles[0].base_judge.status, "pass");
      assert.deepEqual(store.read(summary.run_id).state.last_review.judge_input_verdicts, [justified]);
      const verified = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
      assert.equal(verified.valid, true, verified.reason ?? "");
      assert.deepEqual(verified.receipt.judge_inputs.verdicts, [{ path: judgePath, verdict: "justified" }]);
      assert.equal(verified.receipt.judge_inputs.changes[0].kind, kind);
      for (const verdicts of [
        [],
        [{ path: judgePath, verdict: "unjustified" }],
        [{ path: "src/other/biome.json", verdict: "justified" }],
        undefined,
      ]) {
        const receipt = structuredClone(verified.receipt);
        if (verdicts) receipt.judge_inputs.verdicts = verdicts;
        else delete receipt.judge_inputs.verdicts;
        git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", summary.promoted_head], {
          input: JSON.stringify(receipt),
        });
        const checked = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
        assert.equal(checked.valid, verdicts === undefined, checked.reason ?? "");
        if (verdicts) assert.match(checked.reason ?? "", /missing justified verdict/);
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("FIX without judge input verdicts repairs and can subsequently pass", async () => {
  const { repo, summary, store, implementations } = await runChange(
    {
      decision: "FIX",
      findings: [{ id: "explain", reason: "Explain why formatting is needed.", path: judgePath }],
    },
    "fix",
    true,
  );
  try {
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(implementations, 2);
    assert.equal(store.read(summary.run_id).state.counters.repairs, 1);
    const reviews = store.events(summary.run_id).filter((entry) => entry.type === "review.finished");
    assert.deepEqual(
      reviews.map((entry) => entry.decision),
      ["FIX", "PASS"],
    );
    assert.equal(reviews[0].invalid, undefined);
  } finally {
    repo.cleanup();
  }
});

test("ESCALATE without judge input verdicts remains valid", async () => {
  const { repo, summary, store } = await runChange({
    decision: "ESCALATE",
    reason: "A human must decide whether formatting is required.",
  });
  try {
    assert.equal(summary.outcome, "ESCALATED");
    assert.equal(summary.reason, "reviewer escalated: A human must decide whether formatting is required.");
    const event = store.events(summary.run_id).find((entry) => entry.type === "review.finished");
    assert.equal(event.decision, "ESCALATE");
    assert.equal(event.invalid, undefined);
  } finally {
    repo.cleanup();
  }
});

test("promotion refuses a stored PASS without a justified verdict before taking the lock", async () => {
  const state = initialState("promote");
  state.last_verification = {
    status: "pass",
    candidate_digest: "a".repeat(64),
    checks: [],
    changed_files: [judgePath],
    judge_input_changes: [{ ...declaration, kind: "fix", change: "modified", declared_by: "implementer" }],
    base_judge: { status: "pass", restored: [judgePath], checks: [] },
  };
  state.last_review = {
    decision: "PASS",
    candidate_digest: state.last_verification.candidate_digest,
    findings: [],
  };
  const ctx = /** @type {import("../src/core/context.mjs").RunContext} */ (
    /** @type {unknown} */ ({
      state,
      get stateDir() {
        return assert.fail("must reject before taking the promotion lock");
      },
    })
  );
  await assert.rejects(
    runPromoteStage({ kind: "promote", on: { done: "PASSED" } }, ctx),
    (error) =>
      error instanceof HarnessError && error.errorClass === "integrity" && error.code === "unreviewed",
  );
});

test("reviewer prompt requires independent verdicts on judge input changes", () => {
  const prompt = readFileSync(new URL("../src/prompts/reviewer.md", import.meta.url), "utf8");
  assert.match(prompt, /For each judge_input_changes entry, read the diff/);
  assert.match(
    prompt,
    /needed by the task and does not make any check accept something it would otherwise reject/,
  );
  assert.match(prompt, /declared_reason is the implementer's claim, not evidence/);
  assert.match(prompt, /base_judge pass shows only that this diff passes the old judge/);
  assert.match(prompt, /judge_input_verdicts verdict for every entry when you PASS/);
  assert.match(prompt, /When in doubt use FIX or ESCALATE/);
});
