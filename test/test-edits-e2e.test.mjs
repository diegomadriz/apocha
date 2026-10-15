// @ts-check
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isTestPath, normalizeProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { classifyTestFileChange } from "../src/git/test-edits.mjs";
import { git } from "../src/util/git.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const original =
  'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("original", () => assert.equal(2, 2));\n';
const addition = 'test("added", () => assert.equal(3, 3));\n';
const rewritten = original.replace("assert.equal(2, 2)", "assert.ok(true)");

/** @param {string} root @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {Record<string, unknown>} [task] @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer] */
function run(root, implementer, task = {}, reviewer = passReviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return startRun({
    cwd: root,
    base: "main",
    batch: "test-policy",
    message: "Exercise test policy",
    runtimes: fakeRuntimes(),
    task: valueTask({
      allowed_paths: ["test/"],
      checks: ["ok"],
      max_repair_attempts: 0,
      test_edits: "additive",
      ...task,
    }),
    adapters: { implementer: fake, reviewer: fake },
  });
}

/** @param {string} root @param {string} runId */
function traces(root, runId) {
  const sessions = path.join(new RunStore(root).dir(runId), "sessions");
  return readdirSync(sessions).flatMap((session) =>
    readFileSync(path.join(sessions, session, "tools.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

test("additive permits existing test cases and new tests, recording both in the receipt", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [
            { path: "test/existing.test.mjs", old_text: original, new_text: original + addition },
            { path: "test/new.test.mjs", old_text: "", new_text: original },
          ],
        });
        await call("submit_result", { summary: "Added test cases" });
      },
      {},
      async (context) => {
        assert.deepEqual(context.bundle.added_tests, ["test/new.test.mjs"]);
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        reviewed = true;
        await passReviewer(context);
      },
    );
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "pass"));
    const head = /** @type {string} */ (summary.promoted_head);
    const verified = verifyReceipt(repo.root, "refs/notes/apocha", head);
    assert.equal(verified.valid, true, verified.reason ?? "");
    assert.deepEqual(verified.receipt.tests, {
      policy: "additive",
      added: ["test/new.test.mjs"],
      modified: ["test/existing.test.mjs"],
    });
    // Older v3 notes without test metadata continue to verify.
    delete verified.receipt.tests;
    git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", head], {
      input: JSON.stringify(verified.receipt),
    });
    assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head).valid, true);
  } finally {
    repo.cleanup();
  }
});

test("reviewer rejects an additive early return that passes test-edits", async () => {
  const existing =
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("original", () => {\n  assert.equal(2, 2);\n});\n';
  const repo = makeRepo({ files: { "test/existing.test.mjs": existing } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [
            {
              path: "test/existing.test.mjs",
              old_text: "  assert.equal(2, 2);",
              new_text: "  return;\n  assert.equal(2, 2);",
            },
          ],
        });
        await call("submit_result", { summary: "Added early return" });
      },
      {},
      async (context) => {
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        assert.match(context.bundle.diff, /\+ {2}return;/);
        reviewed = true;
        await context.call("submit_result", {
          decision: "FIX",
          candidate_digest: context.bundle.candidate.candidate_digest,
          findings: [
            {
              id: "early-return",
              path: "test/existing.test.mjs",
              reason: "The added early return bypasses the existing assertion.",
            },
          ],
        });
      },
    );
    assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "pass"));
    assert.notEqual(summary.outcome, "PASSED");
    const state = new RunStore(repo.root).read(summary.run_id);
    assert.equal(state.state.last_review.decision, "FIX");
    assert.equal(state.state.last_review.findings[0].id, "early-return");
  } finally {
    repo.cleanup();
  }
});

test("additive rejects assertion rewrites through apply_patch and giving up cannot pass", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let refused = false;
    const summary = await run(repo.root, async ({ call }) => {
      await assert.rejects(
        call("apply_patch", {
          edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: rewritten }],
        }),
        (error) => {
          assert.match(error.message, /assert.equal\(2, 2\)/);
          assert.match(error.message, /status "blocked"/);
          assert.match(error.message, /Only added lines and added import names/);
          assert.equal(error.message.includes("test_edits"), false);
          return true;
        },
      );
      refused = true;
      await call("submit_result", { summary: "Could not rewrite assertion" });
    });
    assert.equal(refused, true);
    assert.notEqual(summary.outcome, "PASSED");
    const trace = traces(repo.root, summary.run_id);
    assert.ok(trace.some((entry) => entry.tool === "apply_patch" && entry.error_code === "test_edit_policy"));
  } finally {
    repo.cleanup();
  }
});

test("a smuggled assertion rewrite fails the authoritative test-edits check", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    const summary = await run(repo.root, async ({ call, root }) => {
      writeFileSync(path.join(root, "test/existing.test.mjs"), rewritten);
      await call("submit_result", { summary: "Smuggled assertion change" });
    });
    assert.equal(summary.outcome, "FAILED", summary.reason ?? "");
    assert.ok(summary.checks.some((check) => check.id === "test-edits" && check.status === "fail"));
    const state = new RunStore(repo.root).read(summary.run_id);
    assert.deepEqual(state.state.last_verification.checks.find((check) => check.id === "test-edits").files, [
      "test/existing.test.mjs",
    ]);
  } finally {
    repo.cleanup();
  }
});

test("allowed permits assertion edits and identifies modified tests for review", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let reviewed = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await call("apply_patch", {
          edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: rewritten }],
        });
        await call("submit_result", { summary: "Changed existing assertion" });
      },
      { test_edits: "allowed" },
      async (context) => {
        assert.deepEqual(context.bundle.modified_tests, ["test/existing.test.mjs"]);
        assert.deepEqual(context.bundle.added_tests, []);
        reviewed = true;
        await passReviewer(context);
      },
    );
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(reviewed, true);
    assert.deepEqual(
      verifyReceipt(repo.root, "refs/notes/apocha", /** @type {string} */ (summary.promoted_head)).receipt
        .tests,
      {
        policy: "allowed",
        added: [],
        modified: ["test/existing.test.mjs"],
      },
    );
  } finally {
    repo.cleanup();
  }
});

test("new-files rejects even pure additions to existing tests", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    let refused = false;
    const summary = await run(
      repo.root,
      async ({ call }) => {
        await assert.rejects(
          call("apply_patch", {
            edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: original + addition }],
          }),
          /test edit policy 'new-files'/,
        );
        refused = true;
        await call("submit_result", { summary: "Could not add to existing test" });
      },
      { test_edits: "new-files" },
    );
    assert.equal(refused, true);
    assert.notEqual(summary.outcome, "PASSED");
    assert.ok(traces(repo.root, summary.run_id).some((entry) => entry.error_code === "test_edit_policy"));
  } finally {
    repo.cleanup();
  }
});

test("isTestPath uses defaults, directory prefixes, basename wildcards, and exact paths", () => {
  const defaults = normalizeProjectConfig({ version: 1, checks: {} }, "/fixture");
  assert.deepEqual(defaults.tests.paths, ["test/", "tests/", "__tests__/", "*.test.*", "*.spec.*"]);
  for (const file of ["test/a.mjs", "tests/nested/a", "__tests__/a", "src/a.test.mjs", "src/a.spec.js"]) {
    assert.equal(isTestPath(defaults, file), true, file);
  }
  assert.equal(isTestPath(defaults, "src/a.test.mjs/ordinary"), false);
  const custom = normalizeProjectConfig(
    {
      version: 1,
      checks: {},
      tests: { paths: ["qa/", "*.test.mjs", "*.spec.*", "special/check.mjs"] },
    },
    "/fixture",
  );
  for (const file of ["qa/nested/test", "src/a.test.mjs", "src/a.spec.ts", "special/check.mjs"]) {
    assert.equal(isTestPath(custom, file), true, file);
  }
  for (const file of ["other/qa/a", "special/check.mjs.bak", "src/aXtest.mjs", "src/xa.mjs"]) {
    assert.equal(isTestPath(custom, file), false, file);
  }
  const disabled = normalizeProjectConfig({ version: 1, checks: {}, tests: { paths: [] } }, "/fixture");
  assert.equal(isTestPath(disabled, "test/a.test.mjs"), false);
  assert.notEqual(disabled.digest, defaults.digest);
  assert.equal(
    normalizeProjectConfig({ version: 1, checks: {}, tests: {} }, "/fixture").digest,
    defaults.digest,
  );
});

const importBase = 'import { a, b as c } from "./m.mjs";\n';
const cases = [
  {
    name: "middle insertion",
    base: original + addition,
    next: original + 'test("middle", () => {});\n' + addition,
    additive: true,
  },
  {
    name: "named import extension",
    base: 'import { a } from "./m.mjs";\n',
    next: 'import { a, b } from "./m.mjs";\n',
    additive: true,
  },
  {
    name: "aliased import extension",
    base: importBase,
    next: 'import { a, b as c, d } from "./m.mjs";\n',
    additive: true,
  },
  {
    name: "default import extension",
    base: 'import def, { a } from "./m.mjs";\n',
    next: 'import def, { a, b } from "./m.mjs";\n',
    additive: true,
  },
  { name: "assertion change", base: original, next: rewritten, additive: false },
  { name: "dropped import name", base: importBase, next: 'import { a } from "./m.mjs";\n', additive: false },
  {
    name: "changed module",
    base: importBase,
    next: 'import { a, b as c, d } from "./other.mjs";\n',
    additive: false,
  },
  {
    name: "changed alias",
    base: importBase,
    next: 'import { a, b as other } from "./m.mjs";\n',
    additive: false,
  },
  {
    name: "changed default",
    base: 'import def, { a } from "./m.mjs";\n',
    next: 'import other, { a, b } from "./m.mjs";\n',
    additive: false,
  },
  {
    name: "substring assertion change",
    base: original,
    next: original.replace("2, 2", "2, 20"),
    additive: false,
  },
];

// Every scenario exercises the real controller as well as its tool binding.
// Refused changes are written directly to ensure the structural check sees them.
for (const scenario of cases) {
  test(`tool and structural check agree: ${scenario.name}`, async () => {
    const repo = makeRepo({ files: { "test/existing.test.mjs": scenario.base } });
    try {
      const summary = await run(repo.root, async ({ call, root }) => {
        const patch = {
          edits: [{ path: "test/existing.test.mjs", old_text: scenario.base, new_text: scenario.next }],
        };
        if (scenario.additive) await call("apply_patch", patch);
        else {
          await assert.rejects(call("apply_patch", patch), /status "blocked"/);
          writeFileSync(path.join(root, "test/existing.test.mjs"), scenario.next);
        }
        await call("submit_result", { summary: scenario.name });
      });
      assert.equal(summary.outcome, scenario.additive ? "PASSED" : "FAILED", summary.reason ?? "");
      assert.equal(
        summary.checks.find((check) => check.id === "test-edits")?.status,
        scenario.additive ? "pass" : "fail",
      );
    } finally {
      repo.cleanup();
    }
  });
}

test("separate patches are judged cumulatively against base lines", async () => {
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  try {
    const summary = await run(repo.root, async ({ call, root }) => {
      await call("apply_patch", {
        edits: [{ path: "test/existing.test.mjs", old_text: original, new_text: original + addition }],
      });
      await assert.rejects(
        call("apply_patch", {
          edits: [
            {
              path: "test/existing.test.mjs",
              old_text: "assert.equal(2, 2)",
              new_text: "assert.equal(2, 2) && false",
            },
          ],
        }),
        /status "blocked"/,
      );
      assert.equal(readFileSync(path.join(root, "test/existing.test.mjs"), "utf8"), original + addition);
      // Intermediate changes within one call are judged only after all edits compose.
      await call("apply_patch", {
        edits: [
          { path: "test/existing.test.mjs", old_text: original, new_text: rewritten },
          { path: "test/existing.test.mjs", old_text: rewritten, new_text: original + addition },
        ],
      });
      await call("submit_result", { summary: "Kept additive final content" });
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  } finally {
    repo.cleanup();
  }
});

test("classifier preserves ordered lines and reports bounded removals and import extensions", () => {
  for (const scenario of cases) {
    const result = classifyTestFileChange(scenario.base, scenario.next);
    assert.equal(result.additive, scenario.additive, scenario.name);
    if (scenario.name.includes("import extension")) assert.equal(result.import_extensions, 1);
  }
  assert.deepEqual(classifyTestFileChange("X\nY\n", "X\nNEW\nY\n"), {
    additive: true,
    removed_lines: [],
    import_extensions: 0,
  });
  assert.deepEqual(classifyTestFileChange("X\nY\n", "Y\nX\n").removed_lines, ["X"]);
  assert.equal(classifyTestFileChange("", null).additive, false);
  const large = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(
    classifyTestFileChange(large, large.replace("line 1500\n", "line 1500\nNEW\n")).additive,
    true,
  );
  const removed = classifyTestFileChange(large, "");
  assert.equal(removed.additive, false);
  assert.equal(removed.removed_lines.length, 20);
});
