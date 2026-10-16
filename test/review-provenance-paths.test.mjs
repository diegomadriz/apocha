// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const judgePath = "src/biome.json";
const before = '{"linter":{"enabled":true}}\n';
const after = '{"linter":{"enabled":true},"formatter":{"enabled":true}}\n';
const declaration = {
  path: judgePath,
  kind: "fix",
  reason: "Implementer declaration: enable formatting while preserving lint.",
};

for (const blocked of [false, true]) {
  const name = blocked ? "blocked verification isolates prior reasons" : "judge input diff provenance";
  test(name, async () => {
    const repo = makeRepo({ files: { [judgePath]: before } });
    let attempts = 0;
    let reviewed = false;
    const fake = createFakeAdapter({
      handlers: {
        implementer: async ({ call, bundle }) => {
          attempts++;
          if (attempts === 2) {
            assert.ok(bundle.verification_history[0].failed_checks.includes("test"));
            await call("submit_result", {
              status: "blocked",
              summary: "Claim a check conflict.",
              blocked_reason: "The test check conflicts with the requested value.",
            });
            return;
          }
          await call("read_files", { paths: ["src/value.txt", judgePath] });
          await call("apply_patch", {
            edits: [
              { path: judgePath, old_text: before, new_text: after },
              { path: "src/value.txt", old_text: "1\n", new_text: blocked ? "3\n" : "2\n" },
            ],
          });
          await call("submit_result", {
            summary: "Change the value and enable formatting.",
            judge_input_changes: [declaration],
          });
        },
        reviewer: async (context) => {
          reviewed = true;
          const { bundle, call } = context;
          assert.deepEqual(bundle.provenance.untrusted, ["untrusted", "diff"]);
          assert.deepEqual(bundle.untrusted.judge_input_reasons, [
            { path: judgePath, declared_reason: declaration.reason },
          ]);
          if (blocked) {
            assert.equal(bundle.verification.status, "fail");
            assert.ok(
              bundle.verification.checks.some((entry) => entry.id === "test" && entry.status === "fail"),
            );
            assert.equal(bundle.verification.judge_input_changes[0].path, judgePath);
            assert.equal(Object.hasOwn(bundle.verification.judge_input_changes[0], "reason"), false);
            for (const [key, value] of Object.entries(bundle)) {
              if (key !== "untrusted")
                assert.equal(JSON.stringify(value)?.includes(declaration.reason) ?? false, false, key);
            }
            await call("submit_result", {
              decision: "ESCALATE",
              reason: "Scripted blocked-claim response.",
              findings: [],
              candidate_digest: bundle.candidate.candidate_digest,
            });
          } else {
            assert.deepEqual(bundle.provenance.untrusted_paths, ["judge_input_changes[].diff"]);
            assert.match(bundle.judge_input_changes[0].diff, /formatter/);
            await passReviewer(context);
          }
        },
      },
    });
    try {
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "judge-provenance",
        message: "Exercise judge input provenance",
        runtimes: fakeRuntimes(),
        task: valueTask(),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(summary.outcome, blocked ? "ESCALATED" : "PASSED", summary.reason ?? "");
      assert.equal(attempts, blocked ? 2 : 1);
      assert.equal(reviewed, true);
      if (blocked) {
        const state = new RunStore(repo.root).read(summary.run_id).state;
        assert.equal(state.last_verification.judge_input_changes[0].reason, declaration.reason);
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("justified existing test diffs have untrusted provenance paths", async () => {
  const testPath = "test/value.test.mjs";
  const oldTest =
    'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("src/value.txt", "utf8").trim(), "1");\n';
  const newTest = oldTest.replace('"1"', '"2"');
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { tests: { run: ["node", "--test"] } },
      tests: { paths: ["test/"], run_files: { run: ["node", "--test", "{files}"] } },
      sandbox: { mode: "none" },
    },
    files: { [testPath]: oldTest },
  });
  let reviewed = false;
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call }) => {
        await call("read_files", { paths: ["src/value.txt", testPath] });
        await call("apply_patch", {
          edits: [
            { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
            { path: testPath, old_text: oldTest, new_text: newTest },
          ],
        });
        await call("submit_result", { summary: "Change value and its existing test." });
      },
      reviewer: async (context) => {
        reviewed = true;
        assert.deepEqual(context.bundle.provenance.untrusted_paths, ["test_changes[].diff"]);
        assert.deepEqual(context.bundle.provenance.untrusted, ["untrusted", "diff"]);
        assert.equal(context.bundle.test_changes[0].path, testPath);
        assert.equal(context.bundle.test_changes[0].verdict, "necessary");
        assert.match(context.bundle.test_changes[0].diff, /assert.equal/);
        await passReviewer(context);
      },
    },
  });
  try {
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "test-provenance",
      message: "Exercise test diff provenance",
      runtimes: fakeRuntimes(),
      task: valueTask({ allowed_paths: ["src/", "test/"], checks: ["tests"], test_edits: "justified" }),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
  } finally {
    repo.cleanup();
  }
});
