// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { fakeRuntimes, makeRepo, passReviewer, testCandidate, valueTask, writeValue } from "./helpers.mjs";

const manifest = { name: "fixture", dependencies: { tiny: "1.0.0" } };
const lock = {
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { tiny: "1.0.0" } },
    "node_modules/tiny": { version: "1.0.0" },
  },
};

/** @param {Record<string, any>} checks @param {number} [concurrency] */
function fixture(checks, concurrency = 2) {
  const raw = {
    version: 1,
    checks,
    sandbox: { mode: "none" },
    limits: { check_concurrency: concurrency },
  };
  const repo = makeRepo({
    config: raw,
    files: {
      ".gitignore": "node_modules/\n",
      "package.json": JSON.stringify(manifest),
      "package-lock.json": JSON.stringify(lock),
    },
  });
  const modules = path.join(repo.root, "node_modules");
  mkdirSync(path.join(modules, "tiny"), { recursive: true });
  writeFileSync(path.join(modules, ".package-lock.json"), JSON.stringify(lock));
  writeFileSync(path.join(modules, "tiny/package.json"), JSON.stringify({ name: "tiny", version: "1.0.0" }));
  writeFileSync(path.join(modules, "tiny/index.js"), "module.exports = 42;\n");
  symlinkSync("tiny/index.js", path.join(modules, "linked.js"));
  return { ...repo, config: normalizeProjectConfig(raw, repo.root), modules };
}

/** @param {string} code */
function npmCheck(code) {
  return { run: ["node", "-e", code], dependencies: "npm" };
}

let controllerRuns = 0;

/**
 * @param {ReturnType<typeof fixture>} repo
 * @param {Record<string, unknown>} [task]
 * @param {import("../src/adapters/fake/index.mjs").FakeHandler} [implementer]
 * @param {(event: Record<string, unknown>) => void} [onEvent]
 * @param {AbortSignal} [signal]
 */
async function controller(repo, task = {}, implementer = writeValue(2), onEvent, signal) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer: passReviewer } });
  const summary = await startRun({
    cwd: repo.root,
    base: "main",
    batch: `parallel-${++controllerRuns}`,
    message: `Check dependency isolation and ordering ${controllerRuns}`,
    runtimes: fakeRuntimes(),
    task: valueTask({ checks: Object.keys(repo.config.checks), ...task }),
    adapters: { implementer: fake, reviewer: fake },
    onEvent,
    signal,
  });
  const store = new RunStore(repo.root);
  return { summary, state: store.read(summary.run_id).state, events: store.events(summary.run_id), store };
}

test("parallel npm checks have writable isolated copies and validate only once", async () => {
  const probe = (own, other) =>
    npmCheck(`
    const fs = require('node:fs');
    if (fs.existsSync('node_modules/${other}')) process.exit(1);
    fs.writeFileSync('node_modules/${own}', 'private cache');
    setTimeout(() => {
      if (fs.existsSync('node_modules/${other}')) process.exit(1);
      if (require('tiny') !== 42) process.exit(1);
    }, 150);
  `);
  const repo = fixture({
    first: probe("first-cache", "second-cache"),
    second: probe("second-cache", "first-cache"),
  });
  const before = readdirSync(repo.modules).sort();
  const { summary, events } = await controller(repo);
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.deepEqual(readdirSync(repo.modules).sort(), before);
  assert.equal(readFileSync(path.join(repo.modules, "tiny/index.js"), "utf8"), "module.exports = 42;\n");
  assert.equal(events.filter((event) => event.type === "dependencies.validation").length, 1);
});

test("dependency validation is reused across catalog checks and a controller repair", async () => {
  const repo = fixture({
    one: npmCheck("require('tiny')"),
    two: npmCheck(
      "if (require('node:fs').readFileSync('src/value.txt','utf8').trim() !== '3') process.exit(1)",
    ),
    three: npmCheck("require('tiny')"),
  });
  let calls = 0;
  const implementer = async (context) => {
    await writeValue(++calls === 1 ? 2 : 3)(context);
  };
  const { summary, events } = await controller(repo, {}, implementer);
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.equal(calls, 2);
  assert.equal(summary.repairs, 1);
  assert.equal(events.filter((event) => event.type === "dependencies.validation").length, 1);
  // A new run over the same source must validate again.
  const again = await controller(repo, {}, writeValue(3));
  assert.equal(again.summary.outcome, "PASSED", again.summary.reason ?? "");
  assert.equal(again.events.filter((event) => event.type === "dependencies.validation").length, 1);
});

test("a source lock change between controller attempts invalidates dependency validation", async () => {
  const repo = fixture(
    {
      one: npmCheck("require('tiny')"),
      two: npmCheck(
        "if (require('node:fs').readFileSync('src/value.txt','utf8').trim() !== '3') process.exit(1)",
      ),
    },
    1,
  );
  let calls = 0;
  const implementer = async (context) => {
    if (++calls === 2) writeFileSync(path.join(repo.root, "package-lock.json"), JSON.stringify(lock) + "\n");
    await writeValue(calls === 1 ? 2 : 3)(context);
  };
  const { summary, events, state } = await controller(repo, {}, implementer);
  assert.equal(summary.outcome, "ESCALATED");
  assert.match(JSON.stringify(state.last_verification), /source checkout package-lock.json differs/);
  assert.equal(events.filter((event) => event.type === "dependencies.validation").length, 3);
});

test("runCheck invalidates cached inputs and never reuses validation for changed candidates", async () => {
  const repo = fixture({ probe: npmCheck("require('tiny')") });
  const candidate = testCandidate(repo.root, "main");
  let validations = 0;
  const run = () =>
    runCheck({
      candidate,
      config: repo.config,
      check: repo.config.checks.probe,
      backend: "none",
      dependencyOptions: { onValidation: () => validations++ },
    });
  assert.equal((await run()).status, "pass");
  assert.equal((await run()).status, "pass");
  assert.equal(validations, 1);
  writeFileSync(path.join(repo.modules, ".package-lock.json"), JSON.stringify(lock) + " ");
  assert.equal((await run()).status, "pass");
  assert.equal(validations, 2);
  writeFileSync(path.join(candidate.root, "package.json"), JSON.stringify({ name: "changed" }));
  assert.equal((await run()).status, "fail");
  assert.equal(validations, 3);
});

test("parallel controller checks record wall time and deterministic evidence, events and receipts", async () => {
  // All checks sleep at least a second; the first also delays so it finishes last.
  const sleep = (ms) => npmCheck(`setTimeout(() => {}, ${ms})`);
  const repo = fixture({ slow: sleep(3000), second: sleep(1500), third: sleep(1500) });
  const { summary, state, events, store } = await controller(repo);
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  const evidenceFile = `verification-${String(state.attempt).padStart(2, "0")}.json`;
  const verification = JSON.parse(readFileSync(path.join(store.dir(summary.run_id), evidenceFile), "utf8"));
  assert.deepEqual(
    verification.results.map((result) => result.id),
    ["slow", "second", "third"],
  );
  // Sequential execution would take at least 6000 ms.
  assert.ok(verification.duration_ms < 5000, `checks took ${verification.duration_ms}ms`);
  assert.ok(verification.duration_ms >= 3000);
  assert.ok(verification.results.every((result) => result.duration_ms >= 1500));
  assert.ok(verification.results[0].duration_ms > verification.results[1].duration_ms);
  assert.equal(state.last_verification.duration_ms, verification.duration_ms);
  assert.deepEqual(
    events.filter((event) => event.type === "check.finished").map((event) => event.id),
    ["slow", "second", "third"],
  );
  assert.equal(
    events.find((event) => event.type === "verification.finished").duration_ms,
    verification.duration_ms,
  );
  assert.equal(
    events.find((event) => event.type === "stage.completed" && event.stage === "verify").duration_ms,
    verification.duration_ms,
  );
  const receipt = verifyReceipt(
    repo.root,
    "refs/notes/apocha",
    /** @type {string} */ (summary.promoted_head),
  );
  assert.equal(receipt.valid, true, receipt.reason ?? "");
  assert.deepEqual(receipt.receipt.checks.map((check) => check.id).slice(-3), ["slow", "second", "third"]);
});

for (const failFast of [true, false]) {
  test(`controller fail_fast=${failFast} records pending checks deterministically`, async () => {
    const repo = fixture({
      failure: npmCheck("process.exit(1)"),
      running: npmCheck("setTimeout(() => {}, 300)"),
      pending: npmCheck("console.log('started')"),
    });
    const { summary, state, events } = await controller(repo, {
      fail_fast: failFast,
      max_repair_attempts: 0,
    });
    assert.equal(summary.outcome, "ESCALATED");
    const checks = state.last_verification.checks.slice(-3);
    assert.deepEqual(
      checks.map((check) => check.status),
      ["fail", "pass", failFast ? "skipped" : "pass"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "check.finished").map((event) => event.id),
      ["failure", "running", "pending"],
    );
    assert.equal(state.last_verification.duration_ms > 0, true);
    if (failFast) assert.equal(checks[2].duration_ms, 0);
  });
}

test("runCheck falls back when the copy binary is missing and preserves contained links", async () => {
  const repo = fixture({
    probe: npmCheck(
      "if (require('./node_modules/linked.js') !== 42) process.exit(1); require('node:fs').writeFileSync('node_modules/cache','local')",
    ),
  });
  const candidate = testCandidate(repo.root, "main");
  const methods = [];
  const result = await runCheck({
    candidate,
    config: repo.config,
    check: repo.config.checks.probe,
    backend: "none",
    dependencyOptions: {
      copyCommand: path.join(repo.root, "missing-copy-command"),
      onCopied: (method) => methods.push(method),
    },
  });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  assert.deepEqual(methods, ["fallback"]);
  assert.equal(existsSync(path.join(repo.modules, "cache")), false);
});

test("controller abort kills parallel checks and never starts a pending check", async () => {
  const repo = fixture({
    first: npmCheck("setTimeout(() => {}, 10000)"),
    second: npmCheck("setTimeout(() => {}, 10000)"),
    pending: npmCheck("process.exit(0)"),
  });
  const abort = new AbortController();
  let timer;
  const started = Date.now();
  const result = await controller(
    repo,
    {},
    writeValue(2),
    (event) => {
      if (event.type === "verification.started") timer = setTimeout(() => abort.abort(), 200);
    },
    abort.signal,
  );
  clearTimeout(timer);
  assert.equal(result.summary.outcome, "ERROR");
  assert.match(result.summary.reason ?? "", /aborted/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.events.filter((event) => event.type === "check.finished").length, 0);
});

test("check concurrency defaults to two and validates its bounds", () => {
  assert.equal(normalizeProjectConfig({ version: 1, checks: {} }, "/fixture").limits.check_concurrency, 2);
  for (const value of [0, 9, 1.5]) {
    assert.throws(() =>
      normalizeProjectConfig({ version: 1, checks: {}, limits: { check_concurrency: value } }, "/fixture"),
    );
  }
});
