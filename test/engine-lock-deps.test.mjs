// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { initialState } from "../src/core/context.mjs";
import { runEngine } from "../src/core/engine.mjs";
import { withLock } from "../src/core/lock.mjs";
import { validateWorkflow } from "../src/core/workflow.mjs";

import { testCandidate as createCandidate, makeRepo, testTempDir } from "./helpers.mjs";

/** A context with only what the human and budget stages use. */
function stubContext(workflow, state = initialState(workflow.start)) {
  const events = [];
  return {
    ctx: /** @type {any} */ ({
      workflow,
      task: { max_repair_attempts: 2 },
      state,
      event: (type, data) => events.push({ type, ...data }),
      persist: () => {},
    }),
    events,
  };
}

const gated = validateWorkflow({
  id: "gated",
  version: 1,
  start: "approve",
  stages: {
    approve: { kind: "human", on: { approve: "retry", reject: "FAILED" } },
    retry: { kind: "budget", counter: "repairs", on: { available: "retry", exhausted: "PASSED" } },
  },
});

test("a human stage pauses the run until a decision arrives", async () => {
  const { ctx, events } = stubContext(gated);
  const paused = await runEngine(ctx);
  assert.equal(paused.outcome, "PAUSED");
  assert.equal(ctx.state.awaiting, "approve");
  ctx.state.decisions.approve = "approve";
  ctx.state.awaiting = null;
  const done = await runEngine(ctx);
  assert.equal(done.outcome, "PASSED");
  assert.equal(ctx.state.counters.repairs, 2, "the budget stage loops until exhausted");
  assert.ok(events.some((event) => event.type === "human.decided" && event.decision === "approve"));
});

test("a rejected human stage routes to its reject target", async () => {
  const { ctx } = stubContext(gated);
  ctx.state.decisions.approve = "reject";
  const done = await runEngine(ctx);
  assert.equal(done.outcome, "FAILED");
  assert.equal(done.reason, "approve: reject");
});

test("the lock serializes holders and recovers from a dead owner", async () => {
  const dir = testTempDir("lock");
  const order = [];
  await Promise.all([
    withLock(dir, "a", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push("a-end");
    }),
    new Promise((resolve) => setTimeout(resolve, 20)).then(() => withLock(dir, "b", () => order.push("b"))),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
  writeFileSync(path.join(dir, "lock"), JSON.stringify({ pid: 999999, purpose: "dead" }));
  assert.equal(await withLock(dir, "c", () => "recovered", { waitMs: 500 }), "recovered");
  writeFileSync(path.join(dir, "lock"), JSON.stringify({ pid: process.pid, purpose: "alive" }));
  await assert.rejects(
    withLock(dir, "d", () => 1, { waitMs: 200 }),
    /locked by pid/,
  );
});

/** A repo with an npm package that depends on a fake installed module. */
function npmRepo(installedVersion = "1.0.0") {
  const pkg = { name: "fixture", version: "1.0.0", dependencies: { "tiny-dep": "1.0.0" } };
  const lock = {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { "tiny-dep": "1.0.0" } },
      "node_modules/tiny-dep": { version: "1.0.0" },
    },
  };
  const repo = makeRepo({
    config: {
      version: 1,
      checks: {
        uses_dep: { run: ["node", "-e", "console.log(require('tiny-dep'))"], cwd: ".", dependencies: "npm" },
      },
      sandbox: { mode: "none" },
    },
    files: {
      "package.json": `${JSON.stringify(pkg)}\n`,
      "package-lock.json": `${JSON.stringify(lock)}\n`,
      ".gitignore": "node_modules/\n",
    },
  });
  const modules = path.join(repo.root, "node_modules", "tiny-dep");
  mkdirSync(modules, { recursive: true });
  writeFileSync(
    path.join(modules, "package.json"),
    JSON.stringify({ name: "tiny-dep", version: installedVersion, main: "index.js" }),
  );
  writeFileSync(path.join(modules, "index.js"), "module.exports = 'tiny-dep loaded';");
  return repo;
}

test("npm checks get the locked node_modules", async () => {
  const repo = npmRepo();
  const candidate = createCandidate(repo.root, "main");
  try {
    const config = normalizeProjectConfig(
      JSON.parse(String((await import("node:fs")).readFileSync(path.join(repo.root, "apocha.config.json")))),
      repo.root,
    );
    const result = await runCheck({ check: config.checks.uses_dep, candidate, config, backend: "none" });
    assert.equal(result.status, "pass", result.stderr + result.error);
    assert.match(result.stdout, /tiny-dep loaded/);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});

test("npm checks fail when the candidate changes dependencies, and error when installs are stale", async () => {
  const repo = npmRepo();
  const candidate = createCandidate(repo.root, "main");
  try {
    const config = normalizeProjectConfig(
      JSON.parse(String((await import("node:fs")).readFileSync(path.join(repo.root, "apocha.config.json")))),
      repo.root,
    );
    writeFileSync(
      path.join(candidate.root, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { evil: "1.0.0" } }),
    );
    const changed = await runCheck({ check: config.checks.uses_dep, candidate, config, backend: "none" });
    assert.equal(changed.status, "fail");
    assert.match(String(changed.error), /differs from the base commit/);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
  const stale = npmRepo("0.9.0");
  const candidate2 = createCandidate(stale.root, "main");
  try {
    const config = normalizeProjectConfig(
      JSON.parse(String((await import("node:fs")).readFileSync(path.join(stale.root, "apocha.config.json")))),
      stale.root,
    );
    const result = await runCheck({
      check: config.checks.uses_dep,
      candidate: candidate2,
      config,
      backend: "none",
    });
    assert.equal(result.status, "infra_error");
    assert.match(String(result.error), /lock says 1.0.0/);
  } finally {
    candidate2.cleanup();
    stale.cleanup();
  }
});
