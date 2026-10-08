// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { gitCommonDir } from "../src/util/git.mjs";
import { listTempDirs, makeTempDir, removeTempDir } from "../src/util/temp.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testTempDir,
  valueTask,
  writeValue,
} from "./helpers.mjs";

/** @param {import("node:test").TestContext} t */
function isolatedTemp(t) {
  const dir = testTempDir("isolated");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    removeTempDir(dir);
  });
  return dir;
}

test("temp directories carry ownership and removal is idempotent", (t) => {
  const tmp = isolatedTemp(t);
  const dir = makeTempDir("unit-test", { runId: "run-1", repository: tmp });
  t.after(() => removeTempDir(dir));
  assert.equal(dir, realpathSync(dir));
  assert.equal(path.dirname(dir), tmp);
  const owner = JSON.parse(readFileSync(path.join(dir, ".apocha-owner"), "utf8"));
  assert.deepEqual(owner, {
    kind: "unit-test",
    run_id: "run-1",
    pid: process.pid,
    created_at: owner.created_at,
    repository: realpathSync(tmp),
  });
  assert.ok(Number.isFinite(Date.parse(owner.created_at)));
  assert.deepEqual(listTempDirs(), [{ path: dir, kind: "unit-test", owner }]);
  writeFileSync(path.join(dir, "nested.txt"), "x");
  removeTempDir(dir);
  removeTempDir(dir);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(listTempDirs(), []);
  assert.throws(() => makeTempDir("../escape"), /invalid/);
});

test("the inventory includes legacy and unreadable owners and excludes files", (t) => {
  const tmp = isolatedTemp(t);
  const owned = makeTempDir("unit");
  t.after(() => removeTempDir(owned));
  assert.equal(JSON.parse(readFileSync(path.join(owned, ".apocha-owner"), "utf8")).run_id, null);
  const legacy = path.join(tmp, "apocha-legacy-abcdef");
  const broken = path.join(tmp, "apocha-broken-abcdef");
  mkdirSync(legacy);
  mkdirSync(broken);
  writeFileSync(path.join(broken, ".apocha-owner"), "{");
  writeFileSync(path.join(tmp, "apocha-file"), "x");
  mkdirSync(path.join(tmp, "unrelated"));
  const inventory = listTempDirs();
  assert.equal(inventory.length, 3);
  assert.deepEqual(
    inventory.find((entry) => entry.path === legacy),
    {
      path: legacy,
      kind: "legacy",
      owner: null,
    },
  );
  assert.deepEqual(
    inventory.find((entry) => entry.path === broken),
    {
      path: broken,
      kind: "broken",
      owner: null,
    },
  );
});

test("the inventory rejects owner markers with a non-string repository", (t) => {
  isolatedTemp(t);
  const dir = makeTempDir("unit");
  const marker = path.join(dir, ".apocha-owner");
  const owner = JSON.parse(readFileSync(marker, "utf8"));
  for (const repository of [null, 123, {}, []]) {
    writeFileSync(marker, JSON.stringify({ ...owner, repository }));
    assert.equal(listTempDirs().find((entry) => entry.path === dir)?.owner, null);
  }
});

test("finished fake runs leave no temp directories and paused runs retain only the candidate", async (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  isolatedTemp(t);
  const options = {
    cwd: repo.root,
    base: "main",
    message: "Set value",
    runtimes: fakeRuntimes(),
    task: valueTask({ max_repair_attempts: 0 }),
  };
  for (const [value, outcome] of [
    [2, "PASSED"],
    [1, "ESCALATED"],
  ]) {
    const fake = createFakeAdapter({
      handlers: { implementer: writeValue(value), reviewer: passReviewer },
    });
    const result = await startRun({
      ...options,
      batch: `value-${value}`,
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(result.outcome, outcome, result.reason ?? "");
    assert.deepEqual(listTempDirs(), []);
  }
  const limited = createFakeAdapter({
    handlers: {
      implementer: async () => {
        throw new HarnessError("usage_limited", "limit", "try later");
      },
      reviewer: passReviewer,
    },
  });
  const paused = await startRun({
    ...options,
    message: "Set value after resume",
    batch: "paused",
    adapters: { implementer: limited, reviewer: limited },
  });
  assert.equal(paused.outcome, "PAUSED");
  const retained = listTempDirs();
  assert.equal(retained.length, 1);
  assert.equal(retained[0].kind, "candidate");
  assert.equal(retained[0].owner?.run_id, paused.run_id);
  assert.equal(retained[0].owner?.repository, realpathSync(gitCommonDir(repo.root)));
  const fake = createFakeAdapter({ handlers: { implementer: writeValue(2), reviewer: passReviewer } });
  const resumed = await resumeRun({
    cwd: repo.root,
    runId: paused.run_id,
    runtimes: fakeRuntimes(),
    adapters: { implementer: fake, reviewer: fake },
  });
  assert.equal(resumed.outcome, "PASSED", resumed.reason ?? "");
  assert.deepEqual(listTempDirs(), []);
  const controller = new AbortController();
  controller.abort();
  const aborted = await startRun({
    ...options,
    batch: "aborted",
    adapters: { implementer: fake, reviewer: fake },
    signal: controller.signal,
  });
  assert.equal(aborted.outcome, "ERROR");
  assert.deepEqual(listTempDirs(), []);
});
