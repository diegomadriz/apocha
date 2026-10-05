// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newRunId, RunStore } from "../src/core/runs.mjs";
import { makeRepo } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/panagent.mjs", import.meta.url));

test("list marks dead RUNNING runs stale without changing stored records", () => {
  const repo = makeRepo();
  try {
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(child.status, 0, child.stderr?.toString());
    assert.ok(child.pid > 0);
    const store = new RunStore(repo.root);
    const dead = newRunId("dead-run");
    const live = newRunId("live-run");
    const finished = newRunId("finished-run");
    const paused = newRunId("paused-run");
    const meta = { workflow: "code-delivery", base_ref: "main", batch_ref: "batch" };
    store.create(dead, { ...meta, pid: child.pid });
    store.create(live, { ...meta, pid: process.pid });
    store.create(finished, { ...meta, pid: child.pid, outcome: "PASSED" });
    store.create(paused, { ...meta, pid: child.pid, outcome: "PAUSED" });
    const files = [dead, live, finished, paused].map((id) => {
      const file = path.join(store.dir(id), "run.json");
      return { file, content: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
    });

    const runs = store.list();
    assert.equal(runs.find((run) => run.run_id === dead)?.stale, true);
    assert.equal(runs.find((run) => run.run_id === dead)?.outcome, "RUNNING");
    for (const id of [live, finished, paused]) {
      assert.equal(
        Object.hasOwn(
          runs.find((run) => run.run_id === id),
          "stale",
        ),
        false,
      );
    }
    for (const ref of ["main", "batch"]) {
      assert.deepEqual(
        store
          .activeRunsNaming(ref)
          .map((run) => run.run_id)
          .sort(),
        [live, paused].sort(),
      );
    }

    const cli = spawnSync(process.execPath, [BIN, "runs"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp(`^STALE\\s+${dead}\\s`, "m"));
    assert.match(cli.stdout, new RegExp(`^RUNNING\\s+${live}\\s`, "m"));
    assert.match(cli.stdout, new RegExp(`^PASSED\\s+${finished}\\s`, "m"));
    for (const { file, content, mtime } of files) {
      assert.equal(readFileSync(file, "utf8"), content);
      assert.equal(statSync(file).mtimeMs, mtime);
    }
  } finally {
    repo.cleanup();
  }
});

test("list treats EPERM as alive and does not probe runs without a valid pid", (t) => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    store.create(newRunId("permission-run"), { pid: process.pid });
    store.create(newRunId("missing-pid"), {});
    store.create(newRunId("zero-pid"), { pid: 0 });
    store.create(newRunId("finished-run"), { pid: process.pid, outcome: "PASSED" });
    const kill = t.mock.method(process, "kill", () => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    for (const run of store.list()) {
      assert.equal(Object.hasOwn(run, "stale"), false);
    }
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, 0]);
  } finally {
    repo.cleanup();
  }
});
