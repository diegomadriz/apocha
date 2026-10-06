// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const runFiles = { run: ["node", "--test", "{files}"], cwd: ".", timeout_ms: 1000 };
const testPath = "test/value.test.mjs";
const valueTest = (expected) =>
  `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("value", () => assert.equal(readFileSync("src/value.txt", "utf8").trim(), "${expected}"));
`;

const existingBehavior = valueTest(1).replace('"src/value.txt"', '"README.md"').replace('"1"', '"# fixture"');

for (const scenario of [
  { name: "bug fix fails on base", source: valueTest(2), result: "fails_on_base" },
  { name: "existing behavior is advisory", source: existingBehavior, result: "passes_on_base" },
  { name: "strict policy escalates", source: existingBehavior, result: "passes_on_base", strict: true },
  {
    name: "new module import fails on base",
    source:
      'import { value } from "../src/new.mjs";\nimport assert from "node:assert/strict";\nassert.equal(value, 2);\n',
    result: "fails_on_base",
    module: true,
  },
  { name: "disabled config does no base runs", source: valueTest(2), disabled: true },
  { name: "modified test runs on base", source: valueTest(2), result: "fails_on_base", modified: true },
  {
    name: "added helper resolves on base",
    source:
      'import { expected } from "./helper.mjs";\nimport assert from "node:assert/strict";\nassert.equal(expected, 2);\n',
    result: "passes_on_base",
    helper: true,
  },
  {
    name: "infrastructure error is not evidence",
    source: existingBehavior,
    result: "error",
    error: true,
    strict: true,
  },
]) {
  test(`tests on base: ${scenario.name}`, async () => {
    const config = {
      version: 1,
      checks: { ok: { run: ["node", "--test", testPath] } },
      tests: {
        paths: ["test/"],
        ...(scenario.disabled
          ? {}
          : { run_files: scenario.error ? { run: ["apocha-missing-command", "{files}"] } : runFiles }),
      },
      sandbox: { mode: "none" },
    };
    const repo = makeRepo({
      config,
      files: scenario.modified ? { [testPath]: valueTest(1) } : {},
    });
    try {
      let reviewed = false;
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            await call("apply_patch", {
              edits: [
                { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
                {
                  path: testPath,
                  old_text: scenario.modified ? valueTest(1) : "",
                  new_text: scenario.source,
                },
                ...(scenario.module
                  ? [{ path: "src/new.mjs", old_text: "", new_text: "export const value = 2;\n" }]
                  : []),
                ...(scenario.helper
                  ? [{ path: "test/helper.mjs", old_text: "", new_text: "export const expected = 2;\n" }]
                  : []),
              ],
            });
            await call("submit_result", { summary: "Set value and add test" });
          },
          reviewer: async (context) => {
            const evidence = context.bundle.tests_on_base;
            assert.ok(Array.isArray(evidence));
            if (scenario.disabled) assert.deepEqual(evidence, []);
            else assert.equal(evidence.find((entry) => entry.path === testPath).result, scenario.result);
            reviewed = true;
            await passReviewer(context);
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "base-tests",
        message: "Test base evidence",
        runtimes: fakeRuntimes(),
        task: valueTask({
          allowed_paths: ["src/", "test/"],
          checks: ["ok"],
          max_repair_attempts: 0,
          ...(scenario.modified ? { test_edits: "allowed" } : {}),
          new_tests_must_fail_on_base: scenario.strict ?? false,
        }),
        adapters: { implementer: fake, reviewer: fake },
      });
      const rejected = scenario.strict && !scenario.error;
      assert.equal(summary.outcome, rejected ? "ESCALATED" : "PASSED", summary.reason ?? "");
      assert.equal(reviewed, !rejected);
      const state = new RunStore(repo.root).read(summary.run_id).state;
      if (scenario.disabled) assert.deepEqual(state.last_verification.tests_on_base, []);
      else
        assert.equal(
          state.last_verification.tests_on_base.find((entry) => entry.path === testPath).result,
          scenario.result,
        );
      if (rejected) {
        assert.ok(
          summary.checks.some((check) => check.id === "tests-fail-before" && check.status === "fail"),
        );
        assert.match(
          state.findings[0].reason,
          /test\/value\.test\.mjs.*pass on the base code.*do not test the change/,
        );
        assert.deepEqual(state.verification_history[0].failed_checks, ["tests-fail-before"]);
      } else {
        const receipt = verifyReceipt(
          repo.root,
          "refs/notes/apocha",
          /** @type {string} */ (summary.promoted_head),
        );
        assert.equal(receipt.valid, true, receipt.reason ?? "");
        if (scenario.disabled) assert.equal(receipt.receipt.tests.on_base, undefined);
        else
          assert.equal(
            receipt.receipt.tests.on_base.find((entry) => entry.path === testPath).result,
            scenario.result,
          );
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("tests.run_files validates argv and changes the config digest", () => {
  const plain = { version: 1, checks: {} };
  const enabled = normalizeProjectConfig({ ...plain, tests: { run_files: runFiles } }, "/fixture");
  assert.deepEqual(enabled.tests.run_files?.run, runFiles.run);
  assert.notEqual(enabled.digest, normalizeProjectConfig(plain, "/fixture").digest);
  for (const run of [
    ["node", "--test"],
    ["node", "{files}", "{files}"],
    ["node", "prefix{files}"],
  ]) {
    assert.throws(() => normalizeProjectConfig({ ...plain, tests: { run_files: { run } } }, "/fixture"));
  }
});

test("base evidence limits runs to ten and skips deleted tests", async () => {
  const repo = makeRepo({
    files: { "test/deleted.mjs": "throw new Error('deleted');\n" },
    config: {
      version: 1,
      checks: { ok: { run: ["node", "-e", "process.exit(0)"] } },
      tests: { paths: ["test/"], run_files: runFiles },
      sandbox: { mode: "none" },
    },
  });
  try {
    const fake = createFakeAdapter({
      handlers: {
        implementer: async ({ call }) => {
          await call("apply_patch", {
            edits: [
              { path: "test/deleted.mjs", delete: true },
              ...Array.from({ length: 11 }, (_, index) => ({
                path: `test/${String(index).padStart(2, "0")}.mjs`,
                old_text: "",
                new_text: "process.exit(0);\n",
              })),
            ],
          });
          await call("submit_result", { summary: "Add eleven tests" });
        },
        reviewer: async (context) => {
          const evidence = context.bundle.tests_on_base;
          assert.equal(evidence.length, 11);
          assert.equal(evidence.filter((entry) => entry.result === "passes_on_base").length, 10);
          assert.deepEqual(evidence[10], { path: "test/10.mjs", result: "not_run" });
          await passReviewer(context);
        },
      },
    });
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "limit",
      message: "Test evidence limit",
      runtimes: fakeRuntimes(),
      task: valueTask({ allowed_paths: ["test/"], checks: ["ok"], test_edits: "allowed" }),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  } finally {
    repo.cleanup();
  }
});
