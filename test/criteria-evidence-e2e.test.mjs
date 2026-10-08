// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { readReceipt, verifyReceipt } from "../src/git/receipts.mjs";
import { toolDefinitions } from "../src/tools/definitions.mjs";
import { git } from "../src/util/git.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

test("criteria evidence rejects invalid submissions, resubmits, pairs review claims and records receipts", async () => {
  const repo = makeRepo({ files: { "test/value.test.mjs": 'test("value is two", () => {});\n' } });
  const criteria = ["value is two", "value file exists"];
  const claims = [
    { criterion: 2, evidence: [{ kind: "check", check_id: "test" }] },
    {
      criterion: 1,
      evidence: [
        { kind: "test", path: "test/value.test.mjs", name: "value is two" },
        { kind: "inspection", note: "Supplementary inspection of the value file." },
      ],
    },
  ];
  let reviewed = false;
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call }) => {
        const schema = toolDefinitions("implementer").find(
          (tool) => tool.name === "submit_result",
        ).inputSchema;
        for (const keyword of ["if", "then", "else", "not", "allOf", "anyOf", "oneOf"])
          assert.equal(Object.hasOwn(schema, keyword), false);
        assert.match(schema.properties.criteria_evidence.description, /Required.*done/);
        await assert.rejects(call("submit_result", { summary: "done" }), /criteria_evidence is required/);
        // One submission must list every semantic problem, even beyond the old five-error cap.
        await assert.rejects(
          call("submit_result", {
            summary: "invalid",
            criteria_evidence: [
              {
                criterion: 1,
                evidence: [
                  { kind: "test", path: "test/missing.test.mjs", name: "missing" },
                  { kind: "test", path: "test/value.test.mjs", name: "not present" },
                  { kind: "test", path: "src/value.txt", name: "1" },
                  { kind: "check", check_id: "unknown" },
                ],
              },
              { criterion: 1, evidence: [{ kind: "inspection", note: "duplicate" }] },
              { criterion: 3, evidence: [{ kind: "check", check_id: "test" }] },
            ],
          }),
          (error) => {
            for (const problem of [
              /missing criterion 2/,
              /duplicate criterion 1/,
              /does not exist/,
              /does not occur literally/,
              /not a project test path/,
              /unknown check id unknown/,
              /criterion 3 is outside/,
            ])
              assert.match(error.message, problem);
            return true;
          },
        );
        for (const evidence of [
          [],
          [{ kind: "inspection", note: "" }],
          [{ kind: "inspection", note: "x".repeat(501) }],
          [{ kind: "check", check_id: "test", name: "extra" }],
          Array.from({ length: 11 }, () => ({ kind: "check", check_id: "test" })),
        ]) {
          await assert.rejects(
            call("submit_result", { summary: "bad shape", criteria_evidence: [{ criterion: 1, evidence }] }),
            /result is invalid/,
          );
        }
        await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
        await call("submit_result", { status: "done", summary: "set value", criteria_evidence: claims });
      },
      reviewer: async (context) => {
        reviewed = true;
        assert.deepEqual(context.bundle.acceptance_criteria, criteria);
        assert.deepEqual(
          context.bundle.criteria_evidence,
          criteria.map((text, index) => ({
            criterion: index + 1,
            acceptance_criterion: text,
            evidence: claims.find((entry) => entry.criterion === index + 1).evidence,
          })),
        );
        await passReviewer(context);
      },
    },
  });
  try {
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "evidence",
      message: "Set value",
      task: valueTask({ acceptance_criteria: criteria }),
      runtimes: fakeRuntimes(),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
    const record = new RunStore(repo.root).read(summary.run_id);
    assert.deepEqual(record.state.implementation.criteria_evidence, claims);
    assert.deepEqual(record.criteria_evidence, claims);
    assert.deepEqual(summary.criteria_evidence, claims);
    const head = /** @type {string} */ (summary.promoted_head);
    const receipt = readReceipt(repo.root, "refs/notes/apocha", head);
    assert.deepEqual(receipt.criteria_evidence, claims);
    assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head).valid, true);
    delete receipt.criteria_evidence;
    git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", head], {
      input: JSON.stringify(receipt),
    });
    assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head).valid, true);
  } finally {
    repo.cleanup();
  }
});

test("blocked submissions through the controller need no criterion evidence", async () => {
  const repo = makeRepo();
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call }) => {
        await call("submit_result", {
          status: "blocked",
          summary: "Conflict",
          blocked_reason: "check.mjs conflicts with required value",
        });
      },
      reviewer: async ({ bundle, call }) => {
        assert.equal(bundle.blocked_claim.blocked_reason, "check.mjs conflicts with required value");
        await call("submit_result", {
          decision: "ESCALATE",
          findings: [],
          reason: "Confirmed check.mjs conflict",
          candidate_digest: bundle.candidate.candidate_digest,
        });
      },
    },
  });
  try {
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "blocked-evidence",
      message: "Blocked",
      task: valueTask(),
      runtimes: fakeRuntimes(),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "ESCALATED");
    assert.equal(new RunStore(repo.root).read(summary.run_id).state.last_verification, null);
  } finally {
    repo.cleanup();
  }
});
