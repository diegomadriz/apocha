// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { taskDigest } from "../src/config/task.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { loadSchema, validateAgainst } from "../src/util/schema.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const bin = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));
const config = {
  version: 1,
  checks: { tests: { run: ["node", "--test"] } },
  tests: { paths: ["test/"], run_files: { run: ["node", "--test", "{files}"] } },
  sandbox: { mode: "none" },
};

function validate(repo, task, args = []) {
  const file = path.join(repo.root, "task.json");
  writeFileSync(file, JSON.stringify(task));
  return spawnSync(process.execPath, [bin, "validate", ...args, file], {
    cwd: repo.root,
    encoding: "utf8",
  });
}

test("CLI validates declarations, digests reasons and rejects invalid paths and overlap", () => {
  const repo = makeRepo({ config, files: { "test/value.test.mjs": "export {};\n" } });
  try {
    const entry = {
      path: "test/value.test.mjs",
      kind: "refactor",
      reason: "Rename local variables",
    };
    const task = valueTask({
      allowed_paths: ["src/", "test/"],
      checks: ["tests"],
      test_changes: [entry],
    });
    const valid = validate(repo, task);
    assert.equal(valid.status, 0, valid.stderr);
    const normalized = JSON.parse(valid.stdout);
    assert.deepEqual(normalized.test_changes, [entry]);
    assert.notEqual(
      taskDigest(normalized),
      taskDigest({ ...normalized, test_changes: [{ ...entry, reason: "Other reason" }] }),
    );
    for (const changes of [
      [{ ...entry, path: "test/missing.test.mjs" }],
      [{ ...entry, path: "src/value.txt" }],
      [entry, { ...entry, kind: "behaviour" }],
    ]) {
      const bad = validate(repo, { ...task, test_changes: changes });
      assert.equal(bad.status, 2, bad.stdout);
      assert.match(bad.stderr, /test_changes/);
    }
    const outside = validate(repo, { ...task, allowed_paths: ["src/"] });
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /outside allowed_paths/);
    for (const [read, allowed] of [
      ["schemas/", "schemas/task.schema.json"],
      ["schemas/task.schema.json", "schemas/"],
      ["schemas/task.schema.json", "schemas/task.schema.json"],
    ]) {
      const bad = validate(
        repo,
        valueTask({ checks: ["tests"], read_only_paths: [read], allowed_paths: [allowed] }),
      );
      assert.equal(bad.status, 2);
      assert.ok(bad.stderr.includes(read), bad.stderr);
      assert.ok(bad.stderr.includes(allowed), bad.stderr);
      assert.match(bad.stderr, /overlaps/);
    }
  } finally {
    repo.cleanup();
  }
});

test("CLI impact follows base-tree static imports transitively and marks declarations", () => {
  const repo = makeRepo({
    config,
    files: {
      "src/value.mjs": "export const value = 1;\n",
      "test/helper.mjs": 'export { value } from "../src/value.mjs";\n',
      "test/value.test.mjs": 'import { value } from "./helper.mjs";\n',
      "test/dynamic.test.mjs": 'import("./helper.mjs");\n',
      "test/require.test.cjs": 'require("./helper.mjs");\n',
      "test/unrelated.test.mjs": 'import "node:assert";\n',
    },
  });
  try {
    const task = valueTask({
      checks: ["tests"],
      allowed_paths: ["src/value.mjs", "test/value.test.mjs"],
      test_changes: [{ path: "test/value.test.mjs", kind: "behaviour", reason: "Value changes" }],
    });
    // Working-tree edits must not alter the base graph.
    writeFileSync(path.join(repo.root, "test/helper.mjs"), "export {};\n");
    writeFileSync(path.join(repo.root, "test/unrelated.test.mjs"), 'import "../src/value.mjs";\n');
    const result = validate(repo, task, ["--impact", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { impact } = JSON.parse(result.stdout);
    assert.deepEqual(
      impact.find((entry) => entry.path === "test/value.test.mjs"),
      {
        path: "test/value.test.mjs",
        chain: ["test/value.test.mjs", "test/helper.mjs", "src/value.mjs"],
        declared: true,
      },
    );
    assert.equal(
      impact.some((entry) => entry.path === "test/unrelated.test.mjs"),
      false,
    );
    for (const file of ["test/dynamic.test.mjs", "test/require.test.cjs"]) {
      assert.equal(impact.find((entry) => entry.path === file).declared, false);
    }
    const text = validate(repo, task, ["--impact"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(
      text.stdout,
      /test\/value.test.mjs \(declared\): test\/value.test.mjs -> test\/helper.mjs -> src\/value.mjs/,
    );
    assert.equal(text.stdout.includes("unrelated"), false);
  } finally {
    repo.cleanup();
  }
});

for (const kind of ["refactor", "fixture"]) {
  test(`controller accepts declared ${kind} and judges the same undeclared edit`, async () => {
    for (const declared of [true, false]) {
      const file = kind === "fixture" ? "test/helper.mjs" : "test/value.test.mjs";
      const base =
        kind === "fixture"
          ? "export const helper = 1;\n"
          : 'import assert from "node:assert/strict";\nconst value = 1;\nassert.equal(value, 1);\n';
      const next =
        kind === "fixture"
          ? "export const helper = 2;\n"
          : base.replace("const value = 1;", "const value = Number(1);");
      const repo = makeRepo({ config, files: { [file]: base } });
      try {
        let reviewed = false;
        const fake = createFakeAdapter({
          handlers: {
            implementer: async ({ call }) => {
              await call("apply_patch", { edits: [{ path: file, old_text: base, new_text: next }] });
              await call("submit_result", { summary: kind });
            },
            reviewer: async (context) => {
              reviewed = true;
              assert.deepEqual(context.bundle.undeclared_test_changes, []);
              await passReviewer(context);
            },
          },
        });
        const summary = await startRun({
          cwd: repo.root,
          base: "main",
          batch: "declaration",
          message: kind,
          runtimes: fakeRuntimes(),
          task: valueTask({
            allowed_paths: ["test/"],
            checks: ["tests"],
            max_repair_attempts: 0,
            ...(declared
              ? { test_changes: [{ path: file, kind, reason: "Approved test maintenance" }] }
              : {}),
          }),
          adapters: { implementer: fake, reviewer: fake },
        });
        assert.equal(summary.outcome, declared ? "PASSED" : "ESCALATED", summary.reason ?? "");
        assert.equal(reviewed, declared);
        const store = new RunStore(repo.root);
        const evidence = store.read(summary.run_id).state.last_verification.test_changes[0];
        assert.equal(evidence.declared, declared);
        assert.equal(evidence.assertions_preserved, true);
        assert.equal(
          evidence.verdict,
          declared ? (kind === "fixture" ? "declared_fixture" : "refactor") : "unnecessary",
        );
        if (declared) {
          assert.equal(evidence.kind, kind);
          assert.equal(evidence.reason, "Approved test maintenance");
          const receipt = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
          assert.equal(receipt.valid, true, receipt.reason ?? "");
        }
        const runs = store
          .events(summary.run_id)
          .filter((event) => event.type === "test-on-base.finished" && event.path === file);
        assert.equal(runs.length, declared && kind === "fixture" ? 0 : 1);
        assert.equal("old_on_candidate" in evidence, !(declared && kind === "fixture"));
      } finally {
        repo.cleanup();
      }
    }
  });
}

for (const scenario of ["rename", "behaviour", "weakening"]) {
  test(`controller judges declared refactor ${scenario} by execution evidence`, async () => {
    const file = "test/value.test.mjs";
    const base =
      'import assert from "node:assert/strict";\nimport { value } from "../src/value.mjs";\nconst actual = value;\nconst expected = 1;\nassert.equal(actual, expected);\n';
    const next =
      scenario === "rename"
        ? base.replaceAll("actual", "result")
        : scenario === "behaviour"
          ? base.replace("const expected = 1;", "const expected = 2;")
          : base.replace("assert.equal(actual, expected);", "assert.ok(actual);");
    const verdict = scenario === "rename" ? "refactor" : scenario === "behaviour" ? "necessary" : "weakened";
    const assertionsPreserved = scenario === "behaviour";
    const repo = makeRepo({
      config,
      files: { [file]: base, "src/value.mjs": "export const value = 1;\n" },
    });
    try {
      let reviewed = false;
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            await call("apply_patch", {
              edits: [
                { path: file, old_text: base, new_text: next },
                ...(scenario === "rename"
                  ? []
                  : [
                      {
                        path: "src/value.mjs",
                        old_text: "export const value = 1;\n",
                        new_text: "export const value = 2;\n",
                      },
                    ]),
              ],
            });
            await call("submit_result", { summary: scenario });
          },
          reviewer: async (context) => {
            reviewed = true;
            const entry = context.bundle.test_changes[0];
            assert.equal(entry.verdict, verdict);
            assert.equal(entry.assertions_preserved, assertionsPreserved);
            if (scenario === "rename") {
              assert.deepEqual(
                context.bundle.refactors_to_check.map((item) => item.path),
                [file],
              );
              assert.match(context.bundle.refactors_to_check[0].reason, /assertion.*heuristic/i);
            } else {
              assert.deepEqual(context.bundle.refactors_to_check, []);
              assert.match(entry.note, /declaration.*did not match.*evidence/i);
            }
            await passReviewer(context);
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: scenario,
        message: scenario,
        runtimes: fakeRuntimes(),
        task: valueTask({
          allowed_paths: ["src/", "test/"],
          checks: ["tests"],
          max_repair_attempts: 0,
          test_changes: [{ path: file, kind: "refactor", reason: "Refactor" }],
        }),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(summary.outcome, scenario === "weakening" ? "ESCALATED" : "PASSED", summary.reason ?? "");
      assert.equal(reviewed, scenario !== "weakening");
      const verification = new RunStore(repo.root).read(summary.run_id).state.last_verification;
      const entry = verification.test_changes[0];
      assert.equal(entry.verdict, verdict);
      assert.equal(entry.assertions_preserved, assertionsPreserved);
      assert.equal(
        entry.old_on_candidate,
        scenario === "rename" ? "old_passes_on_candidate" : "old_fails_on_candidate",
      );
      assert.equal(entry.new_on_base, scenario === "behaviour" ? "fails_on_base" : "passes_on_base");
      if (scenario !== "rename") {
        assert.match(entry.note, /declaration.*did not match.*evidence/i);
      }
      const check = verification.checks.find((item) => item.id === "test-changes");
      assert.equal(check.status, scenario === "weakening" ? "fail" : "pass");
      if (scenario === "weakening") {
        assert.equal(
          check.error,
          `${file} now passes on both the old and the new code, so it no longer distinguishes them`,
        );
      } else {
        const receipt = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
        assert.equal(receipt.valid, true, receipt.reason ?? "");
        assert.equal(receipt.receipt.tests.test_changes[0].assertions_preserved, assertionsPreserved);
        if (scenario === "behaviour") {
          assert.equal(receipt.receipt.tests.test_changes[0].note, entry.note);
        }
        const oldReceipt = structuredClone(receipt.receipt);
        for (const change of oldReceipt.tests.test_changes) {
          delete change.assertions_preserved;
          delete change.note;
        }
        assert.deepEqual(validateAgainst(loadSchema("receipt-v3.schema.json"), oldReceipt), []);
      }
    } finally {
      repo.cleanup();
    }
  });
}
