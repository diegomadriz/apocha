// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkApochaDependencies } from "../src/adapters/dependencies.mjs";
import * as cliMain from "../src/cli/main.mjs";
import { taskDigest } from "../src/config/task.mjs";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));
const WARNING =
  'warning: tests.run_files is not set, so changes to existing tests are limited to additions; set tests.run_files, or give the task test_edits "allowed" with test_changes declarations';
const missing = () => import.meta.resolve("apocha-test-module-that-does-not-exist");

/** @param {unknown} error */
function dependencyError(error) {
  assert.ok(error instanceof HarnessError);
  assert.equal(error.errorClass, "infra");
  assert.equal(error.code, "harness_dependencies_missing");
  assert.match(error.message, /Apocha's own dependencies are not installed in .*; run npm ci there/);
  assert.ok(error.message.includes(fileURLToPath(new URL("../", import.meta.url))));
  return true;
}

test("dependency preflight resolves both MCP server imports", () => {
  const resolved = [];
  assert.equal(
    checkApochaDependencies((specifier) => {
      resolved.push(specifier);
      return specifier;
    }).ok,
    true,
  );
  assert.deepEqual(resolved, ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio"]);
  const result = checkApochaDependencies((specifier) => {
    if (specifier === "@modelcontextprotocol/server/stdio") return missing();
    return specifier;
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /Apocha's own dependencies are not installed in .*; run npm ci there/);
});

for (const name of ["codex", "claude-code", "pi"]) {
  for (const role of ["implementer", "reviewer"]) {
    test(`dependency preflight checks ${name} ${role} before any invocation`, async () => {
      const repo = makeRepo();
      let invocations = 0;
      const adapter = createFakeAdapter({ handlers: { implementer: writeValue(2), reviewer: passReviewer } });
      const counted = {
        ...adapter,
        run: async (invocation) => {
          invocations++;
          return adapter.run(invocation);
        },
      };
      const adapters = { implementer: counted, reviewer: counted };
      adapters[role] = { ...counted, name };
      await assert.rejects(
        startRun({
          cwd: repo.root,
          base: "main",
          batch: "missing",
          message: "test",
          task: valueTask(),
          runtimes: fakeRuntimes(),
          adapters,
          resolveDependency: missing,
        }),
        dependencyError,
      );
      assert.equal(invocations, 0);
    });
  }
}

test("integrate checks configured MCP roles and emits fallback for justified", async () => {
  const repo = makeRepo();
  git(repo.root, ["checkout", "-qb", "topic"]);
  writeFileSync(path.join(repo.root, "src/value.txt"), "2\n");
  git(repo.root, ["commit", "-qam", "set value"]);
  git(repo.root, ["checkout", "-q", "main"]);
  const adapter = createFakeAdapter({ handlers: { implementer: writeValue(2), reviewer: passReviewer } });
  const options = {
    cwd: repo.root,
    workflow: /** @type {const} */ ("integrate"),
    base: "main",
    batch: "integration",
    message: "integrate",
    integration: { topic: "topic", testEdits: /** @type {const} */ ("justified") },
    adapters: { implementer: adapter, reviewer: adapter },
  };
  await assert.rejects(
    startRun({
      ...options,
      resolveDependency: missing,
      runtimes: fakeRuntimes({
        roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "codex", model: "test" } },
      }),
    }),
    dependencyError,
  );
  const events = [];
  const summary = await startRun({
    ...options,
    runtimes: fakeRuntimes(),
    resolveDependency: missing,
    onEvent: (event) => events.push(event),
  });
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.equal(events.filter((event) => event.type === "test-policy.fallback").length, 1);
});

test("fake runs ignore missing MCP dependencies; resume checks before invoking", async () => {
  const repo = makeRepo();
  const adapter = createFakeAdapter({
    handlers: {
      implementer: () => {
        throw new HarnessError("usage_limited", "limit", "usage limit reached");
      },
      reviewer: passReviewer,
    },
  });
  const paused = await startRun({
    cwd: repo.root,
    base: "main",
    batch: "resume",
    message: "test",
    task: valueTask(),
    runtimes: fakeRuntimes(),
    adapters: { implementer: adapter, reviewer: adapter },
    resolveDependency: missing,
  });
  assert.equal(paused.outcome, "PAUSED");
  let invocations = 0;
  const real = {
    ...adapter,
    name: "codex",
    run: async (invocation) => {
      invocations++;
      return adapter.run(invocation);
    },
  };
  await assert.rejects(
    resumeRun({
      cwd: repo.root,
      runId: paused.run_id,
      runtimes: fakeRuntimes(),
      adapters: { implementer: adapter, reviewer: real },
      resolveDependency: missing,
    }),
    dependencyError,
  );
  assert.equal(invocations, 0);
  assert.equal(new RunStore(repo.root).read(paused.run_id).outcome, "PAUSED");
});

test("doctor reports dependency success and the missing-dependency fix", async () => {
  const repo = makeRepo();
  const cli = spawnSync(process.execPath, [BIN, "doctor", "--json"], { cwd: repo.root, encoding: "utf8" });
  const rows = JSON.parse(cli.stdout);
  assert.equal(rows.find((row) => row.name === "apocha dependencies")?.ok, true);
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await cliMain.doctor(repo.root, { live: false, json: false, resolveDependency: missing });
  } finally {
    process.stdout.write = original;
  }
  assert.match(
    output,
    /FAIL {2}apocha dependencies: Apocha's own dependencies are not installed in .*; run npm ci there/,
  );
});

for (const variant of ["default", "justified", "run-files", "allowed"]) {
  test(`run fallback event and progress: ${variant}`, () => {
    const repo = makeRepo();
    if (variant === "run-files") {
      writeFileSync(
        path.join(repo.root, "apocha.config.json"),
        JSON.stringify({
          version: 1,
          checks: { test: { run: ["node", "check.mjs"] } },
          default_checks: ["test"],
          sandbox: { mode: "none" },
          tests: { run_files: { run: ["node", "--test", "{files}"], cwd: ".", timeout_ms: 300000 } },
        }),
      );
      git(repo.root, ["add", "apocha.config.json"]);
      git(repo.root, ["commit", "-qm", "test runner"]);
    }
    const script = path.join(repo.root, "fake.mjs");
    writeFileSync(
      script,
      `export default {
      async implementer({ bundle, call }) {
        await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
        await call("submit_result", { summary: "set value", criteria_evidence: bundle.acceptance_criteria.map((_, i) => ({ criterion: i + 1, evidence: [{ kind: "check", check_id: "test" }] })) });
      },
      async reviewer({ bundle, call }) {
        await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
      }
    };`,
    );
    const runtimes = path.join(repo.root, "runtimes.json");
    writeFileSync(
      runtimes,
      JSON.stringify({
        version: 1,
        roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        adapters: { fake: { script } },
      }),
    );
    const task = path.join(repo.root, "task.json");
    writeFileSync(
      task,
      JSON.stringify(
        valueTask(variant === "allowed" || variant === "justified" ? { test_edits: variant } : {}),
      ),
    );
    const cli = spawnSync(
      process.execPath,
      [
        BIN,
        "run",
        task,
        "--base",
        "main",
        "--batch",
        variant,
        "--message",
        "test",
        "--runtimes",
        runtimes,
        "--json",
        "--quiet",
      ],
      { cwd: repo.root, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    const summary = JSON.parse(cli.stdout);
    const record = new RunStore(repo.root).read(summary.run_id);
    assert.equal(record.task_digest, taskDigest(record.task));
    const events = new RunStore(repo.root)
      .events(summary.run_id)
      .filter((event) => event.type === "test-policy.fallback");
    const fallback = variant === "default" || variant === "justified";
    assert.equal(events.length, fallback ? 1 : 0);
    assert.equal(cli.stderr.includes(WARNING + "\n"), fallback);
    if (fallback) {
      assert.equal(events[0].policy, "justified");
      assert.equal(events[0].effective, "additive");
      assert.equal(events[0].reason, "tests.run_files is not set");
    }
  });
}
