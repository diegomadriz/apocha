// @ts-check
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexAdapter } from "../src/adapters/codex/index.mjs";
import { runJsonlProcess, runtimeEnvironment } from "../src/adapters/process.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { fakeRuntimes, makeRepo, testTempDir, valueTask } from "./helpers.mjs";

function standIn() {
  const root = testTempDir("abort-runtime");
  const counter = path.join(root, "starts");
  const command = path.join(root, "runtime");
  writeFileSync(counter, "");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("codex 0.160.0");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(counter)}, process.pid + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "stand-in" }));
process.stdin.resume();
setTimeout(() => process.exit(0), 2000);
`,
  );
  chmodSync(command, 0o755);
  return { root, counter, command };
}

/** @param {string} counter */
function starts(counter) {
  return readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("aborting a real codex adapter run stops its only runtime without retrying", async () => {
  const runtime = standIn();
  const repo = makeRepo();
  const controller = new AbortController();
  const adapter = createCodexAdapter({ command: runtime.command });
  const pending = startRun({
    cwd: repo.root,
    base: "main",
    batch: "abort-runtime",
    message: "test abort",
    task: valueTask(),
    runtimes: fakeRuntimes({ retry: { infra: 1 } }),
    adapters: { implementer: adapter, reviewer: adapter },
    signal: controller.signal,
  });
  try {
    const deadline = Date.now() + 10000;
    while (starts(runtime.counter).length === 0 && Date.now() < deadline) await delay(10);
    assert.equal(starts(runtime.counter).length, 1, "runtime started before abort");
    controller.abort();
    const summary = await pending;
    assert.equal(summary.outcome, "ERROR");
    assert.equal(summary.error_class, "infra");
    assert.equal(summary.code, "aborted");
    assert.equal(starts(runtime.counter).length, 1);
    assert.equal(summary.retries, 0);
    const events = new RunStore(repo.root).events(summary.run_id);
    assert.equal(
      events.some((event) => event.type === "agent.retry"),
      false,
    );
    for (const pid of starts(runtime.counter)) assert.equal(alive(pid), false, `runtime ${pid} exited`);
  } finally {
    controller.abort();
    await pending;
    for (const pid of starts(runtime.counter)) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    repo.cleanup();
  }
});

test("an already-aborted process invocation rejects without spawning", async () => {
  const runtime = standIn();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runJsonlProcess({
      command: runtime.command,
      args: [],
      cwd: runtime.root,
      env: runtimeEnvironment(),
      input: "",
      timeoutMs: 5000,
      signal: controller.signal,
      onEvent() {},
    }),
    { errorClass: "infra", code: "aborted" },
  );
  assert.deepEqual(starts(runtime.counter), []);
});
