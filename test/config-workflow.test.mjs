// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProjectConfig, selectChecks } from "../src/config/project.mjs";
import { normalizeRuntimeConfig } from "../src/config/runtime.mjs";
import { effectiveProtectedPaths, validateTask } from "../src/config/task.mjs";
import { STAGE_OUTCOMES, validateWorkflow } from "../src/core/workflow.mjs";
import { failureFirst, failureSignalLines, utf8Prefix, utf8Suffix } from "../src/util/bounded.mjs";
import { canonicalJson } from "../src/util/digest.mjs";
import { canonicalPath, isForbidden } from "../src/util/paths.mjs";
import { validateAgainst } from "../src/util/schema.mjs";
import { WORKFLOWS } from "../src/workflows/index.mjs";

const config = normalizeProjectConfig(
  {
    version: 1,
    checks: {
      lint: { run: ["npm", "run", "lint"], cwd: "web", dependencies: "npm" },
      test: { run: ["pytest"], cwd: "." },
    },
    check_selection: [
      { paths: ["web/"], checks: ["lint"] },
      { paths: ["src/", "tests/"], checks: ["test"] },
    ],
    paths: { protected: [".github/"], governance: ["AGENTS.md"], forbidden: ["private/"] },
  },
  "/repo",
);

test("project config fills defaults and always protects its own files", () => {
  assert.equal(config.refs.batch_prefix, "refs/heads/apocha/batch/");
  assert.ok(config.paths.governance.includes("apocha.config.json"));
  assert.ok(config.paths.governance.includes(".apocha/"));
  assert.ok(config.sandbox.deny_read.includes("~/.ssh"));
  assert.equal(config.checks.test.dependencies, "none");
  assert.match(config.digest, /^[0-9a-f]{64}$/);
});

test("project config rejects unknown keys, unknown checks, and bad paths", () => {
  assert.throws(
    () => normalizeProjectConfig({ version: 1, checks: {}, extra: 1 }, "/r"),
    /extra is not allowed/,
  );
  assert.throws(
    () => normalizeProjectConfig({ version: 1, checks: {}, default_checks: ["nope"] }, "/r"),
    /unknown check/,
  );
  assert.throws(
    () => normalizeProjectConfig({ version: 1, checks: { a: { run: ["x"], cwd: "../up" } } }, "/r"),
    /escapes/,
  );
  assert.throws(
    () => normalizeProjectConfig({ version: 1, checks: { a: { run: "x" } } }, "/r"),
    /must be array/,
  );
});

test("always_readable defaults, canonical validation, and config digest", () => {
  const raw = { version: 1, checks: {} };
  const defaults = normalizeProjectConfig(raw, "/repo");
  assert.deepEqual(defaults.paths.always_readable, ["AGENTS.md"]);
  const explicit = normalizeProjectConfig({ ...raw, paths: { always_readable: ["AGENTS.md"] } }, "/repo");
  assert.equal(defaults.digest, explicit.digest);
  for (const entries of [[], ["docs/guide.md"], ["notes/"]]) {
    const custom = normalizeProjectConfig({ ...raw, paths: { always_readable: entries } }, "/repo");
    assert.deepEqual(custom.paths.always_readable, entries);
    assert.notEqual(defaults.digest, custom.digest);
  }
  for (const entry of ["../AGENTS.md", "./AGENTS.md", "a//AGENTS.md", ".git/config"]) {
    assert.throws(() => normalizeProjectConfig({ ...raw, paths: { always_readable: [entry] } }, "/repo"));
  }
});

test("initial_context accepts always_readable while forbidden paths still win", () => {
  const raw = {
    task_id: "instructions",
    description: "read instructions",
    acceptance_criteria: ["read"],
    allowed_paths: ["src/"],
    initial_context: ["sub/AGENTS.md"],
  };
  assert.deepEqual(validateTask(raw, config).initial_context, ["sub/AGENTS.md"]);
  assert.throws(() => validateTask({ ...raw, initial_context: ["private/AGENTS.md"] }, config), /forbidden/);
  const disabled = normalizeProjectConfig(
    { version: 1, checks: {}, paths: { always_readable: [] } },
    "/repo",
  );
  assert.throws(() => validateTask(raw, disabled), /outside allowed/);
  const custom = normalizeProjectConfig(
    { version: 1, checks: {}, paths: { always_readable: ["docs/guide.md", "notes/"] } },
    "/repo",
  );
  assert.deepEqual(
    validateTask({ ...raw, initial_context: ["docs/guide.md", "notes/info.md"] }, custom).initial_context,
    ["docs/guide.md", "notes/info.md"],
  );
});

test("check selection unions every matching rule", () => {
  assert.deepEqual(selectChecks(config, ["web/app.ts"]), ["lint"]);
  assert.deepEqual(selectChecks(config, ["web/app.ts", "tests/test_x.py"]), ["lint", "test"]);
  assert.deepEqual(selectChecks(config, ["README.md"]), []);
});

test("tasks are validated against the schema and the project config", () => {
  const task = validateTask(
    { task_id: "t1", description: "d", acceptance_criteria: ["c"], allowed_paths: ["src/"] },
    config,
  );
  assert.deepEqual(task.checks, ["test"]);
  assert.equal(task.checks_selected_by_rule, true);
  assert.equal(task.max_repair_attempts, 1);
  const bad = (overrides, pattern) =>
    assert.throws(
      () =>
        validateTask(
          {
            task_id: "t1",
            description: "d",
            acceptance_criteria: ["c"],
            allowed_paths: ["src/"],
            ...overrides,
          },
          config,
        ),
      pattern,
    );
  bad({ commands: ["rm -rf /"] }, /commands is not allowed/);
  bad({ checks: ["deploy"] }, /unknown check/);
  bad({ allowed_paths: ["private/x"] }, /forbidden/);
  bad({ allowed_paths: ["Private/x"] }, /forbidden/);
  bad({ allowed_paths: [".git/hooks/"] }, /\.git/);
  bad({ initial_context: ["docs/x.md"] }, /outside allowed/);
  bad({ design_reference: ["src/x.md"] }, /design_reference/);
  bad({ max_repair_attempts: 3 }, /must be <= 2/);
  bad({ task_id: "Bad ID" }, /task_id/);
});

test("governance paths are protected unless the run allows governance edits", () => {
  const task = validateTask(
    { task_id: "t1", description: "d", acceptance_criteria: ["c"], allowed_paths: ["src/"] },
    config,
  );
  assert.ok(effectiveProtectedPaths(task, config, false).includes("AGENTS.md"));
  assert.ok(!effectiveProtectedPaths(task, config, true).includes("AGENTS.md"));
  assert.ok(effectiveProtectedPaths(task, config, true).includes("private/"));
});

test("runtime config requires a model for real adapters", () => {
  assert.throws(
    () =>
      normalizeRuntimeConfig(
        { version: 1, roles: { implementer: { adapter: "codex" }, reviewer: { adapter: "fake" } } },
        "x",
      ),
    /model is required/,
  );
  const ok = normalizeRuntimeConfig(
    {
      version: 1,
      roles: {
        implementer: { adapter: "codex", model: "m" },
        reviewer: { adapter: "claude-code", model: "n", effort: "high" },
      },
    },
    "x",
  );
  assert.equal(ok.budgets.max_tool_calls, 150);
  assert.equal(ok.retry.infra, 1);
});

test("built-in workflows are valid and route every outcome", () => {
  for (const workflow of Object.values(WORKFLOWS)) {
    for (const stage of Object.values(workflow.stages)) {
      assert.deepEqual(Object.keys(stage.on).sort(), [...STAGE_OUTCOMES[stage.kind]].sort());
    }
  }
});

test("workflow validation catches unrouted outcomes, unknown targets, and unreachable stages", () => {
  const base = {
    id: "w",
    version: 1,
    start: "a",
    stages: { a: { kind: "budget", counter: "c", on: { available: "a", exhausted: "PASSED" } } },
  };
  assert.ok(validateWorkflow(base));
  assert.throws(
    () =>
      validateWorkflow({ ...base, stages: { a: { kind: "budget", counter: "c", on: { available: "a" } } } }),
    /not routed/,
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        stages: { a: { kind: "budget", counter: "c", on: { available: "zz", exhausted: "PASSED" } } },
      }),
    /unknown target/,
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        stages: { ...base.stages, b: { kind: "human", on: { approve: "PASSED", reject: "FAILED" } } },
      }),
    /unreachable/,
  );
  assert.throws(
    () => validateWorkflow({ ...base, stages: { a: { kind: "teleport", on: {} } } }),
    /unknown stage kind/,
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...base,
        stages: { a: { kind: "agent", on: { done: "PASSED", no_changes: "FAILED" } } },
      }),
    /need a role/,
  );
});

test("paths must be canonical and forbidden matching ignores case", () => {
  for (const bad of ["", "/abs", "a/../b", "./a", "a//b", "a\\b", "..", "a\u0000b"])
    assert.throws(() => canonicalPath(bad), bad);
  assert.equal(canonicalPath("src/"), "src/");
  assert.equal(isForbidden("PRIVATE/x", ["private/"]), true);
  assert.equal(isForbidden("a/.GIT/x", []), true);
});

test("bounded text keeps valid UTF-8 and puts failure lines first", () => {
  assert.equal(utf8Prefix("héllo", 2), "h");
  assert.equal(utf8Suffix("héllo", 4), "llo");
  const output = `${"noise\n".repeat(500)}src/x.ts:12:3 error TS2345: bad\n${"noise\n".repeat(500)}done`;
  assert.deepEqual(failureSignalLines(output), ["src/x.ts:12:3 error TS2345: bad"]);
  const kept = failureFirst(output, 200);
  assert.ok(kept.startsWith("src/x.ts:12:3 error TS2345: bad"));
  assert.ok(Buffer.byteLength(kept) <= 200);
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("the schema validator refuses unsupported keywords", () => {
  assert.throws(() => validateAgainst({ type: "string", format: "email" }, "x"), /not supported/);
  assert.deepEqual(validateAgainst({ type: ["string", "null"] }, null), []);
});
