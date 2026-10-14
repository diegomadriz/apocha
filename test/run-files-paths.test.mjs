// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canRunTestPath, normalizeProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { assertValid } from "../src/util/schema.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testTempDir,
  valueTask,
} from "./helpers.mjs";

const spec = "test/e2e/value.spec.mjs";
const unit = "test/unit/value.test.mjs";
const source = (value) => `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
assert.equal(readFileSync("src/value.txt", "utf8").trim(), "${value}");
`;

for (const scenario of [
  "modified",
  "deleted",
  "addition",
  "unit",
  "added",
  "unfiltered",
  "limit",
  "fixture",
]) {
  test(`run_files.paths controller evidence: ${scenario}`, async () => {
    const log = path.join(testTempDir("run-files-log"), "calls.jsonl");
    const filtered = scenario !== "unfiltered";
    const target = scenario === "unit" ? unit : spec;
    const fixture = scenario === "fixture";
    const original = fixture ? "export const expected = 1;\n" : source(1);
    const repo = makeRepo({
      config: {
        version: 1,
        checks: { ok: { run: ["node", "-e", "process.exit(0)"] } },
        tests: {
          paths: ["test/"],
          run_files: {
            run: [
              "node",
              "-e",
              `const fs = require("node:fs"); const files = process.argv.slice(1); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(files) + "\\n"); if (files.some(f => f.includes("e2e"))) process.exit(1); const r = require("node:child_process").spawnSync(process.execPath, ["--test", ...files], {stdio: "inherit"}); process.exit(r.status ?? 1);`,
              "{files}",
            ],
            ...(filtered ? { paths: ["test/unit/"] } : {}),
          },
        },
        sandbox: { mode: "none" },
      },
      files: { [spec]: original, [unit]: source(1) },
    });
    try {
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            const edits = [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }];
            if (scenario === "deleted") {
              await call("apply_patch", { edits: [{ path: target, delete: true }, ...edits] });
            } else {
              if (scenario === "added" || scenario === "limit") {
                edits.push({ path: "test/e2e/added.spec.mjs", old_text: "", new_text: source(2) });
                if (scenario === "limit")
                  for (let i = 0; i < 10; i++)
                    edits.push({ path: `test/unit/${i}.test.mjs`, old_text: "", new_text: source(2) });
              } else {
                edits.push({
                  path: target,
                  old_text: scenario === "unit" ? source(1) : original,
                  new_text:
                    scenario === "addition"
                      ? original + "assert.ok(true);\n"
                      : fixture
                        ? "export const expected = 2;\n"
                        : source(2),
                });
              }
              await call("apply_patch", { edits });
            }
            await call("submit_result", { summary: scenario });
          },
          reviewer: passReviewer,
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "filtered-tests",
        message: scenario,
        runtimes: fakeRuntimes(),
        task: valueTask({
          allowed_paths: ["src/", "test/"],
          checks: ["ok"],
          max_repair_attempts: 0,
          ...(fixture
            ? { test_changes: [{ path: spec, kind: "fixture", reason: "Update support value" }] }
            : {}),
        }),
        adapters: { implementer: fake, reviewer: fake },
      });
      const rejected = scenario === "modified" || scenario === "deleted";
      assert.equal(summary.outcome, rejected ? "ESCALATED" : "PASSED", summary.reason ?? "");
      const state = new RunStore(repo.root).read(summary.run_id).state;
      const verification = state.last_verification;
      const calls = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      if (filtered) assert.ok(calls.flat().every((file) => file.startsWith("./test/unit/")));
      if (rejected) {
        assert.deepEqual(
          verification.test_changes.map((entry) => entry.verdict),
          ["unevaluated"],
        );
        assert.equal(verification.test_changes[0].old_on_candidate, undefined);
        const reason = `${spec} is outside tests.run_files.paths, so this change cannot be evaluated; restore it or only add to it`;
        assert.equal(verification.checks.find((entry) => entry.id === "test-changes").error, reason);
        assert.ok(state.findings.some((entry) => entry.reason.includes(reason)));
        assert.deepEqual(calls, []);
      } else if (scenario === "unit" || scenario === "unfiltered") {
        assert.equal(verification.test_changes[0].verdict, "necessary");
        assert.equal(verification.test_changes[0].new_on_base, "fails_on_base");
        assert.equal(verification.test_changes[0].old_on_candidate, "old_fails_on_candidate");
        assert.deepEqual(calls, [[`./${target}`], [`./${target}`]]);
      } else if (fixture) {
        assert.equal(verification.test_changes[0].verdict, "declared_fixture");
        assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(verification.test_changes, []);
        assert.equal(calls.length, scenario === "limit" ? 10 : 0);
      }
      if (scenario !== "deleted" && scenario !== "fixture") {
        const evidencePath =
          scenario === "added" || scenario === "limit" ? "test/e2e/added.spec.mjs" : target;
        assert.equal(
          verification.tests_on_base.find((entry) => entry.path === evidencePath).result,
          filtered && scenario !== "unit" ? "not_run" : "fails_on_base",
        );
      }
      if (scenario === "limit")
        assert.equal(
          verification.tests_on_base.filter((entry) => entry.result === "fails_on_base").length,
          10,
        );
      if (!rejected) {
        const receipt = verifyReceipt(
          repo.root,
          "refs/notes/apocha",
          /** @type {string} */ (summary.promoted_head),
        );
        assert.equal(receipt.valid, true, receipt.reason ?? "");
        // Verify old entries still validate alongside the new verdict, which has no execution evidence.
        const document = structuredClone(receipt.receipt);
        document.tests.test_changes = [
          { path: spec, change: "modified", declared: false, verdict: "unevaluated" },
        ];
        assert.doesNotThrow(() => assertValid("receipt-v3.schema.json", document, "receipt"));
        document.tests.test_changes = [
          { path: spec, change: "deleted", declared: false, verdict: "unevaluated" },
        ];
        assert.doesNotThrow(() => assertValid("receipt-v3.schema.json", document, "receipt"));
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("run_files.paths normalizes, hashes, validates and reuses tests.paths matching", () => {
  const raw = {
    version: 1,
    checks: {},
    tests: { paths: ["test/"], run_files: { run: ["node", "{files}"] } },
  };
  const plain = normalizeProjectConfig(raw, "/fixture");
  for (const paths of [["test/unit/"], ["*.test.*"], ["qa/check.mjs"], []]) {
    const config = normalizeProjectConfig(
      { ...raw, tests: { ...raw.tests, run_files: { ...raw.tests.run_files, paths } } },
      "/fixture",
    );
    assert.deepEqual(config.tests.run_files.paths, paths);
    assert.notEqual(config.digest, plain.digest);
    assert.equal(
      canRunTestPath(config, "test/unit/a.test.mjs"),
      paths[0] === "test/unit/" || paths[0] === "*.test.*",
    );
    assert.equal(canRunTestPath(config, "qa/check.mjs"), paths[0] === "qa/check.mjs");
    assert.equal(canRunTestPath(config, "test/e2e/a.spec.mjs"), false);
  }
  assert.equal(canRunTestPath(plain, spec), true);
  for (const paths of [["../test/"], [".git/"], ["test/", "test/"], "test/"]) {
    assert.throws(() =>
      normalizeProjectConfig(
        { ...raw, tests: { ...raw.tests, run_files: { ...raw.tests.run_files, paths } } },
        "/fixture",
      ),
    );
  }
});

test("validate and validate --impact report existing editable tests outside run_files.paths", () => {
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { ok: { run: ["node", "--version"] } },
      tests: {
        paths: ["test/"],
        run_files: { run: ["node", "--test", "{files}"], paths: ["test/unit/"] },
      },
    },
    files: { [spec]: source(1), [unit]: source(1) },
  });
  try {
    const manifest = path.join(repo.root, "task.json");
    writeFileSync(manifest, JSON.stringify(valueTask({ allowed_paths: ["src/", "test/"], checks: ["ok"] })));
    for (const flags of [[], ["--impact"], ["--impact", "--json"]]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)), "validate", manifest, ...flags],
        { cwd: repo.root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stderr.includes(`${spec} is outside tests.run_files.paths; only additions will be accepted`),
      );
      assert.ok(!result.stderr.includes(unit));
    }
  } finally {
    repo.cleanup();
  }
});
