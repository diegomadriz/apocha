// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { validateTask } from "../src/config/task.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { classifyTestFileChange } from "../src/git/test-edits.mjs";
import { git } from "../src/util/git.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const testPath = "test/value.test.mjs";
const testSource = (assertion) => `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const value = readFileSync("src/value.txt", "utf8").trim();
${assertion}
`;
const oldSource = testSource('assert.equal(value, "hello");');
const newSource = testSource('assert.equal(value, "world");');
const looseSource = testSource("assert.ok(value);");
const config = {
  version: 1,
  checks: { tests: { run: ["node", "--test"] } },
  tests: { paths: ["test/"], run_files: { run: ["node", "--test", "{files}"] } },
  sandbox: { mode: "none" },
};

for (const scenario of [
  { name: "intentional message change", source: true, next: newSource, verdict: "necessary" },
  { name: "gratuitous loosening", next: looseSource, verdict: "unnecessary" },
  { name: "accepts both behaviours", source: true, next: looseSource, verdict: "weakened" },
  { name: "unnecessary deletion", deleted: true, verdict: "unnecessary" },
  { name: "removed feature", source: true, deleted: true, verdict: "necessary" },
]) {
  test(`justified: ${scenario.name}`, async () => {
    const repo = makeRepo({
      config,
      files: { [testPath]: oldSource, "src/value.txt": "hello\n", "test/sentinel.test.mjs": "export {};\n" },
    });
    try {
      let reviewed = false;
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            await call("apply_patch", {
              edits: [
                ...(scenario.source
                  ? [{ path: "src/value.txt", old_text: "hello\n", new_text: "world\n" }]
                  : []),
                scenario.deleted
                  ? { path: testPath, delete: true }
                  : { path: testPath, old_text: oldSource, new_text: scenario.next },
              ],
            });
            await call("submit_result", { summary: scenario.name });
          },
          reviewer: async (context) => {
            reviewed = true;
            const entry = context.bundle.test_changes[0];
            assert.equal(entry.verdict, scenario.verdict);
            assert.equal(entry.path, testPath);
            assert.match(entry.diff, /-assert.equal\(value, "hello"\);/);
            if (!scenario.deleted) assert.match(entry.diff, /\+assert.equal\(value, "world"\);/);
            await passReviewer(context);
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "justified",
        message: scenario.name,
        runtimes: fakeRuntimes(),
        task: valueTask({ allowed_paths: ["src/", "test/"], checks: ["tests"], max_repair_attempts: 0 }),
        adapters: { implementer: fake, reviewer: fake },
      });
      const necessary = scenario.verdict === "necessary";
      assert.equal(summary.outcome, necessary ? "PASSED" : "ESCALATED", summary.reason ?? "");
      assert.equal(reviewed, necessary);
      const store = new RunStore(repo.root);
      const state = store.read(summary.run_id).state;
      const evidence = state.last_verification.test_changes;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].verdict, scenario.verdict);
      assert.equal(evidence[0].change, scenario.deleted ? "deleted" : "modified");
      assert.equal(
        evidence[0].old_on_candidate,
        scenario.source ? "old_fails_on_candidate" : "old_passes_on_candidate",
      );
      if (scenario.deleted) assert.equal("new_on_base" in evidence[0], false);
      else
        assert.equal(
          evidence[0].new_on_base,
          scenario.next === newSource ? "fails_on_base" : "passes_on_base",
        );
      const saved = JSON.parse(
        readFileSync(path.join(store.dir(summary.run_id), "verification-01.json"), "utf8"),
      );
      assert.deepEqual(saved.test_changes, evidence);
      assert.equal(
        summary.checks.find((entry) => entry.id === "test-changes").status,
        necessary ? "pass" : "fail",
      );
      assert.deepEqual(state.last_verification.checks.find((entry) => entry.id === "test-edits").files, [
        testPath,
      ]);
      if (necessary) {
        const head = /** @type {string} */ (summary.promoted_head);
        const receipt = verifyReceipt(repo.root, "refs/notes/apocha", head);
        assert.equal(receipt.valid, true, receipt.reason ?? "");
        assert.equal(receipt.receipt.tests.policy, "justified");
        assert.deepEqual(receipt.receipt.tests.test_changes, evidence);
        delete receipt.receipt.tests.test_changes;
        git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", head], {
          input: JSON.stringify(receipt.receipt),
        });
        assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head).valid, true);
      } else {
        assert.deepEqual(state.verification_history[0].failed_checks, ["test-changes"]);
        assert.match(
          state.findings[0].reason,
          scenario.verdict === "weakened"
            ? /now passes on both the old and the new code, so it no longer distinguishes them/
            : /the old version of test\/value.test.mjs still passes on the new code, so the change was not needed; restore it or only add to it/,
        );
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("justified is the normalized and schema default", () => {
  const project = normalizeProjectConfig(config, "/fixture");
  assert.equal(validateTask(valueTask({ checks: ["tests"] }), project).test_edits, "justified");
});

for (const policy of ["justified", "additive", "new-files", "allowed"]) {
  test(`test policy compatibility: ${policy}`, async () => {
    const repo = makeRepo({ config, files: { [testPath]: oldSource, "src/value.txt": "hello\n" } });
    try {
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            const patch = {
              edits: [
                {
                  path: testPath,
                  old_text: oldSource,
                  new_text:
                    policy === "allowed" ? looseSource : oldSource + "assert.equal(value.length, 5);\n",
                },
              ],
            };
            if (policy === "new-files")
              await assert.rejects(call("apply_patch", patch), /test edit policy 'new-files'/);
            else await call("apply_patch", patch);
            await call("apply_patch", {
              edits: [{ path: "test/new.test.mjs", old_text: "", new_text: oldSource }],
            });
            await call("submit_result", { summary: "Test policy compatibility" });
          },
          reviewer: async (context) => {
            assert.deepEqual(context.bundle.test_changes, []);
            await passReviewer(context);
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "compatibility",
        message: "Test policies",
        runtimes: fakeRuntimes(),
        task: valueTask({ allowed_paths: ["test/"], checks: ["tests"], test_edits: policy }),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    } finally {
      repo.cleanup();
    }
  });
}

test("unnecessary edits go through repair and restoring the test passes", async () => {
  const repo = makeRepo({ config, files: { [testPath]: oldSource, "src/value.txt": "hello\n" } });
  try {
    let attempts = 0;
    const fake = createFakeAdapter({
      handlers: {
        implementer: async ({ call, bundle }) => {
          if (attempts++) {
            assert.equal(bundle.findings[0].check_id, "test-changes");
            assert.match(bundle.findings[0].reason, /still passes/);
          }
          await call("apply_patch", {
            edits:
              attempts === 1
                ? [{ path: testPath, old_text: oldSource, new_text: looseSource }]
                : [
                    { path: testPath, old_text: looseSource, new_text: oldSource },
                    { path: "test/new.test.mjs", old_text: "", new_text: oldSource },
                  ],
          });
          await call("submit_result", { summary: "Restore unnecessary edit in repair" });
        },
        reviewer: passReviewer,
      },
    });
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "repair",
      message: "Repair test edit",
      runtimes: fakeRuntimes(),
      task: valueTask({ allowed_paths: ["test/"], checks: ["tests"] }),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(attempts, 2);
    const state = new RunStore(repo.root).read(summary.run_id).state;
    assert.deepEqual(state.verification_history[0].failed_checks, ["test-changes"]);
    assert.deepEqual(state.last_verification.test_changes, []);
  } finally {
    repo.cleanup();
  }
});

for (const failure of ["limit", "infra"]) {
  test(`justified evidence rejects ${failure}`, async () => {
    const files = Object.fromEntries(
      Array.from({ length: failure === "limit" ? 11 : 1 }, (_, index) => [
        `test/${index}.test.mjs`,
        oldSource,
      ]),
    );
    const repo = makeRepo({
      files: { ...files, "src/value.txt": "hello\n" },
      config:
        failure === "limit"
          ? config
          : {
              ...config,
              tests: { ...config.tests, run_files: { run: ["apocha-missing-command", "{files}"] } },
            },
    });
    try {
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call }) => {
            await call("apply_patch", {
              edits: Object.keys(files).map((file) => ({
                path: file,
                old_text: oldSource,
                new_text: looseSource,
              })),
            });
            await call("submit_result", { summary: failure });
          },
          reviewer: async () => {
            assert.fail("unverified edits must not reach review");
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: failure,
        message: failure,
        runtimes: fakeRuntimes(),
        task: valueTask({ allowed_paths: ["test/"], checks: ["tests"], max_repair_attempts: 0 }),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.notEqual(summary.outcome, "PASSED");
      const state = new RunStore(repo.root).read(summary.run_id).state;
      const result = state.last_verification.checks.find((entry) => entry.id === "test-changes");
      assert.equal(result.status, failure === "limit" ? "fail" : "infra_error");
      if (failure === "limit") {
        assert.match(result.error, /11 changed existing test files exceeds the limit of 10/);
        assert.equal(state.last_verification.test_changes.length, 10);
      } else assert.equal(state.last_verification.test_changes[0].verdict, "error");
    } finally {
      repo.cleanup();
    }
  });
}

test("large tests with a single insertion are additive within two seconds", () => {
  const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
  const base = lines.join("\n");
  lines.splice(10_000, 0, "inserted");
  const started = performance.now();
  assert.equal(classifyTestFileChange(base, lines.join("\n")).additive, true);
  assert.ok(performance.now() - started < 2000);
});

test("large unmatched middles use a bounded conservative classification", () => {
  const result = classifyTestFileChange("old\n".repeat(3000), "new\n".repeat(3000));
  assert.equal(result.additive, false);
  assert.match(result.removed_lines[0], /exceeds 4,000,000 LCS cells/);
});
