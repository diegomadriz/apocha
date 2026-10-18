// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestHook, normalizeProjectConfig } from "../src/config/project.mjs";
import { validateTask } from "../src/config/task.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { classifyTestBypasses, classifyTestFileChange } from "../src/git/test-edits.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const file = "test/existing.test.mjs";
const base = 'test("existing", (t) => {\n  assert.ok(true);\n});\n';
const python = "def test_existing():\n    assert True\n";
const attacks = [
  { name: "early return", base, next: base.replace("  assert", "  return;\n  assert") },
  { name: "process exit", base, next: base.replace("  assert", "  process.exit(0);\n  assert") },
  { name: "registration skip", base, next: base.replace("test(", "test.skip(") },
  { name: "registration only", base, next: base.replace("test(", "test.only(") },
  { name: "skip option", base, next: base.replace("(t)", "{ skip: true }, (t)") },
  { name: "todo option", base, next: base.replace("(t)", "{ todo: 'later' }, (t)") },
  { name: "runtime skip", base, next: base.replace("  assert", "  t.skip();\n  assert") },
  {
    name: "pytest skip",
    base: python,
    next: python.replace("    assert", "    pytest.skip('later')\n    assert"),
  },
  { name: "pytestmark", base: python, next: "pytestmark = pytest.mark.skip\n" + python },
  { name: "pytest decorator", base: python, next: "@pytest.mark.skip\n" + python },
  { name: "module exit", base: "assert.ok(true);\n", next: "process.exit(0);\nassert.ok(true);\n" },
];
for (const attack of attacks) {
  test("classifier detects " + attack.name, () => {
    const findings = classifyTestBypasses(attack.base, attack.next);
    assert.ok(findings.length, attack.name);
    for (const finding of findings) {
      assert.ok(finding.line >= 1 && finding.line <= attack.next.split("\n").length);
      assert.ok(finding.reason);
    }
  });
}
const skipped = 'test.skip("existing", () => { return; });';
const legitimate = [
  { base, next: "// return; process.exit(0); test.skip('existing')\n" + base },
  { base, next: 'const fixture = "pytest.skip(); pytestmark = test.only";\n' + base },
  { base, next: "function helper() { return false; }\n" + base },
  { base, next: base.replace("  assert", "  assert.equal(1, 1);\n  assert") },
  { base, next: base + 'test.skip("new", () => { return; process.exit(0); });\n' },
  {
    base: skipped,
    next: "\n// moved\n" + skipped.replace("test.skip", "test . skip").replace("return;", "return ;"),
  },
  { base: python, next: python + "\n@pytest.mark.skip\ndef test_new():\n    pytest.skip()\n" },
  { base, next: base.replace("  assert", "  if (unavailable) t.skip();\n  assert") },
];
test("classifier has no findings for eight legitimate lexical cases", () => {
  for (const scenario of legitimate)
    assert.deepEqual(classifyTestBypasses(scenario.base, scenario.next), [], scenario.next);
  assert.deepEqual(classifyTestBypasses(base, attacks[0].next), [
    { line: 2, reason: "first-statement return" },
  ]);
  const oldPython = "@pytest.mark.skip\ndef test_existing():\n    pytest.skip('same')\n";
  assert.deepEqual(classifyTestBypasses(oldPython, "\n# moved\n" + oldPython), []);
  assert.deepEqual(
    classifyTestBypasses(python, python + '\nfixture = """pytest.skip()\npytestmark = []\n"""\n'),
    [],
  );
});

const config = {
  version: 1,
  checks: { ok: { run: ["node", "-e", "0"] } },
  tests: {
    paths: ["test/"],
    hook_files: ["support/*.hook"],
    run_files: { run: ["node", "-e", "0", "{files}"] },
  },
  sandbox: { mode: "none" },
};

/** @param {string} root @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {Record<string, unknown>} [overrides] */
function run(root, implementer, overrides = {}) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer: passReviewer } });
  return startRun({
    cwd: root,
    base: "main",
    batch: "bypasses",
    message: "Test bypass declarations",
    runtimes: fakeRuntimes(),
    task: valueTask({
      allowed_paths: ["test/", "support/", "config/", "src/"],
      checks: ["ok"],
      max_repair_attempts: 0,
      ...overrides,
    }),
    adapters: { implementer: fake, reviewer: fake },
  });
}

for (const attack of attacks) {
  for (const declared of [false, true]) {
    test("bypass gate " + attack.name + (declared ? " declared" : " undeclared"), async () => {
      const repo = makeRepo({ config, files: { [file]: attack.base } });
      try {
        const summary = await run(
          repo.root,
          async ({ call }) => {
            await call("apply_patch", {
              edits: [{ path: file, old_text: attack.base, new_text: attack.next }],
            });
            await call("submit_result", { summary: attack.name });
          },
          declared
            ? {
                test_changes: [
                  {
                    path: file,
                    kind: "refactor",
                    reason: "Exercise explicit owner declaration and evidence",
                  },
                ],
              }
            : {},
        );
        const state = new RunStore(repo.root).read(summary.run_id).state;
        if (declared) {
          assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
          const evidence = state.last_verification.test_changes;
          if (classifyTestFileChange(attack.base, attack.next).additive) assert.deepEqual(evidence, []);
          else {
            assert.equal(evidence[0].verdict, "refactor");
            assert.equal(evidence[0].old_on_candidate, "old_passes_on_candidate");
          }
        } else {
          assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
          assert.match(
            state.last_verification.checks.find((c) => c.id === "test-bypasses").error,
            /test\/existing.test.mjs:\d+: .*requires a test_changes declaration/,
          );
          assert.ok(state.findings.some((f) => f.reason.includes(file)));
        }
      } finally {
        repo.cleanup();
      }
    });
  }
}

for (const policy of ["additive", "justified"]) {
  test("additive early return gate under " + policy, async () => {
    const repo = makeRepo({ config, files: { [file]: base } });
    try {
      const summary = await run(
        repo.root,
        async ({ call }) => {
          await call("apply_patch", {
            edits: [{ path: file, old_text: base, new_text: attacks[0].next }],
          });
          await call("submit_result", { summary: "Add bypass" });
        },
        { test_edits: policy },
      );
      assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
      assert.equal(summary.checks.find((c) => c.id === "test-bypasses").status, "fail");
    } finally {
      repo.cleanup();
    }
  });
}

for (const policy of ["additive", "justified", "new-files", "allowed"]) {
  for (const hook of ["config/conftest.py", "config/pytest.ini", "config/setup.cfg", "support/filter.hook"]) {
    for (const declared of [false, true]) {
      test(
        "new hook under " + policy + " " + hook + (declared ? " fixture declared" : " judge-only rejected"),
        async () => {
          const repo = makeRepo({ config });
          try {
            const builtin = hook.startsWith("config/");
            const summary = await run(
              repo.root,
              async ({ call }) => {
                await call("apply_patch", { edits: [{ path: hook, old_text: "", new_text: "# hook\n" }] });
                await call("submit_result", {
                  summary: "Add hook",
                  ...(builtin
                    ? {
                        judge_input_changes: [
                          { path: hook, kind: "extend", reason: "Add hook configuration" },
                        ],
                      }
                    : {}),
                });
              },
              {
                test_edits: policy,
                ...(declared
                  ? { test_changes: [{ path: hook, kind: "fixture", reason: "Add test hook" }] }
                  : {}),
              },
            );
            const verification = new RunStore(repo.root).read(summary.run_id).state.last_verification;
            assert.equal(summary.outcome, declared ? "PASSED" : "ESCALATED", summary.reason ?? "");
            if (declared && builtin) {
              assert.equal(verification.judge_input_changes[0].path, hook);
              assert.equal(verification.base_judge.status, "pass");
              assert.deepEqual(verification.base_judge.restored, [hook]);
            }
            if (!declared)
              assert.ok(verification.checks.find((c) => c.id === "test-bypasses").error.includes(hook));
          } finally {
            repo.cleanup();
          }
        },
      );
    }
  }
}

test("task validator narrowly admits new hook fixtures and keeps scope and duplicate guards", () => {
  const repo = makeRepo({ config });
  try {
    const project = normalizeProjectConfig(config, repo.root);
    const declaration = { path: "config/conftest.py", kind: "fixture", reason: "Add a hook" };
    const manifest = valueTask({
      allowed_paths: ["config/", "support/"],
      checks: ["ok"],
      test_changes: [declaration],
    });
    assert.doesNotThrow(() => validateTask(manifest, project));
    assert.doesNotThrow(() =>
      validateTask({ ...manifest, test_changes: [{ ...declaration, path: "support/x.hook" }] }, project),
    );
    for (const entry of [
      { ...declaration, kind: "behaviour" },
      { ...declaration, kind: "refactor" },
      { ...declaration, path: "config/nonexistent.py" },
      { ...declaration, path: "outside/conftest.py" },
      { ...declaration, path: "config/../conftest.py" },
      { ...declaration, path: "config/conftest.py/" },
      { ...declaration, path: "config/.git/conftest.py" },
    ])
      assert.throws(() => validateTask({ ...manifest, test_changes: [entry] }, project));
    assert.throws(() => validateTask({ ...manifest, test_changes: [declaration, declaration] }, project));
    assert.equal(isTestHook(project, "config/setup.cfg"), true);
    assert.equal(isTestHook(project, "support/x.hook"), true);
    assert.equal(isTestHook(project, "elsewhere/x.hook"), false);
    assert.notEqual(
      project.digest,
      normalizeProjectConfig({ ...config, tests: { paths: ["test/"] } }, repo.root).digest,
    );
    for (const pattern of ["**/x", "support/*/x", "../x", ".git/x"])
      assert.throws(() => normalizeProjectConfig({ ...config, tests: { hook_files: [pattern] } }, repo.root));
  } finally {
    repo.cleanup();
  }
});

for (const declaration of ["none", "behaviour", "refactor"]) {
  for (const outside of [false, true]) {
    test("justified deletion " + declaration + (outside ? " outside run_files" : " in scope"), async () => {
      const old =
        'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("src/value.txt", "utf8").trim(), "1");\n';
      const repo = makeRepo({
        config: {
          ...config,
          tests: {
            paths: ["test/"],
            run_files: {
              run: ["node", "--test", "{files}"],
              ...(outside ? { paths: ["test/unit/"] } : {}),
            },
          },
        },
        files: { [file]: old },
      });
      try {
        const summary = await run(
          repo.root,
          async ({ call }) => {
            await call("apply_patch", {
              edits: [
                { path: file, delete: true },
                { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
              ],
            });
            await call("submit_result", { summary: "Remove obsolete feature test" });
          },
          declaration === "none"
            ? {}
            : {
                test_changes: [
                  { path: file, kind: declaration, reason: "Remove obsolete feature assertion" },
                ],
              },
        );
        const state = new RunStore(repo.root).read(summary.run_id).state;
        const evidence = state.last_verification.test_changes[0];
        const result = state.last_verification.checks.find((c) => c.id === "test-changes");
        if (outside) {
          assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
          assert.equal(
            result.error,
            file +
              " is outside tests.run_files.paths, so this change cannot be evaluated; restore it or only add to it",
          );
          assert.equal(evidence.verdict, "unevaluated");
        } else {
          assert.equal(
            summary.outcome,
            declaration === "behaviour" ? "PASSED" : "ESCALATED",
            summary.reason ?? "",
          );
          assert.equal(evidence.old_on_candidate, "old_fails_on_candidate");
          assert.equal(evidence.verdict, "necessary");
          assert.equal(evidence.change, "deleted");
          assert.equal(evidence.declared, declaration !== "none");
          if (declaration !== "behaviour") {
            assert.ok(result.error.includes(file + ": deleting an existing test requires a behaviour"));
            assert.ok(state.findings.some((f) => f.reason.includes(file)));
          }
        }
      } finally {
        repo.cleanup();
      }
    });
  }
}
