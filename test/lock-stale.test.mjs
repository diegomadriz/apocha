// @ts-check
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unlockStale, withLock } from "../src/core/lock.mjs";
import { stateDir } from "../src/core/runs.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

const deadOwner = { pid: 2147483647, purpose: "interrupted land", at: "2026-10-01T00:00:00Z" };
const stale = JSON.stringify(deadOwner);
const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));

test("a dead owner's lock fails closed and stays byte-identical", async () => {
  const dir = testTempDir("stale-lock");
  const file = path.join(dir, "lock");
  writeFileSync(file, stale);
  await assert.rejects(
    withLock(dir, "waiter", () => assert.fail("entered stale lock")),
    (error) => {
      assert.equal(error.code, "stale_lock");
      assert.equal(error.errorClass, "infra");
      for (const value of Object.values(deadOwner)) assert.ok(error.message.includes(String(value)));
      assert.match(
        error.message,
        /confirm no apocha command is still running for this repository, then run "apocha unlock"/,
      );
      return true;
    },
  );
  assert.deepEqual(readFileSync(file), Buffer.from(stale));
});

test("an unparseable lock fails closed and stays byte-identical", async () => {
  const dir = testTempDir("invalid-lock");
  const file = path.join(dir, "lock");
  for (const content of ["{broken", "null", "{}"]) {
    writeFileSync(file, content);
    await assert.rejects(
      withLock(dir, "waiter", () => assert.fail("entered invalid lock"), { waitMs: 150 }),
      {
        code: "stale_lock",
      },
    );
    assert.deepEqual(readFileSync(file), Buffer.from(content));
  }
});

test("empty and unparseable locks wait before failing closed", async () => {
  const dir = testTempDir("pending-lock");
  const file = path.join(dir, "lock");
  for (const content of ["", "{broken"]) {
    writeFileSync(file, content);
    const start = Date.now();
    await assert.rejects(
      withLock(dir, "waiter", () => assert.fail("entered pending lock"), { waitMs: 150 }),
      { code: "stale_lock" },
    );
    assert.ok(Date.now() - start >= 150);
    assert.equal(readFileSync(file, "utf8"), content);
  }
});

test("an empty lock replaced by a live owner waits and times out as locked", async () => {
  const dir = testTempDir("pending-live-lock");
  const file = path.join(dir, "lock");
  const content = JSON.stringify({ pid: process.pid, token: "live-holder", purpose: "live" });
  writeFileSync(file, "");
  const timer = setTimeout(() => writeFileSync(file, content), 20);
  const start = Date.now();
  try {
    await assert.rejects(
      withLock(dir, "waiter", () => assert.fail("entered live lock"), { waitMs: 150 }),
      { code: "locked" },
    );
    assert.ok(Date.now() - start >= 150);
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    clearTimeout(timer);
  }
});

test("an empty lock deleted during the wait lets the waiter acquire", async () => {
  const dir = testTempDir("pending-deleted-lock");
  const file = path.join(dir, "lock");
  writeFileSync(file, "");
  const timer = setTimeout(() => rmSync(file), 20);
  try {
    assert.equal(await withLock(dir, "waiter", () => "entered", { waitMs: 500 }), "entered");
    assert.equal(existsSync(file), false);
  } finally {
    clearTimeout(timer);
  }
});

test("holders see complete owner JSON and leave no temporary files on success or stale failure", async () => {
  const dir = testTempDir("atomic-lock");
  const file = path.join(dir, "lock");
  const temporaryFiles = () => readdirSync(dir).filter((name) => /^lock\..*\.tmp$/.test(name));
  await withLock(dir, "holder", async () => {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.purpose, "holder");
    assert.ok(Number.isFinite(Date.parse(owner.at)));
    assert.match(owner.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(temporaryFiles(), []);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).token, owner.token);
  });
  assert.equal(existsSync(file), false);
  assert.deepEqual(temporaryFiles(), []);
  writeFileSync(file, stale);
  await assert.rejects(
    withLock(dir, "waiter", () => assert.fail("entered stale lock")),
    { code: "stale_lock" },
  );
  assert.deepEqual(temporaryFiles(), []);
  assert.equal(readFileSync(file, "utf8"), stale);
});

test("release preserves a replacement lock and records an owner token", async () => {
  const dir = testTempDir("replacement-lock");
  const file = path.join(dir, "lock");
  const replacement = JSON.stringify({ pid: process.pid, token: "another-holder", purpose: "replacement" });
  await withLock(dir, "original", () => {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.purpose, "original");
    assert.ok(Number.isFinite(Date.parse(owner.at)));
    assert.match(owner.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    rmSync(file);
    writeFileSync(file, replacement);
  });
  assert.equal(readFileSync(file, "utf8"), replacement);
});

test("unlockStale removes a dead lock and withLock can acquire and release again", async () => {
  const dir = testTempDir("unlock-dead");
  const file = path.join(dir, "lock");
  writeFileSync(file, stale);
  assert.deepEqual(unlockStale(dir, {}), { removed: true, forced: false });
  assert.equal(await withLock(dir, "recovered", () => "entered"), "entered");
  assert.equal(existsSync(file), false);
  assert.deepEqual(unlockStale(dir, {}), { removed: false, forced: false });
});

test("unlockStale refuses a live owner unless forced", () => {
  const dir = testTempDir("unlock-live");
  const file = path.join(dir, "lock");
  const content = JSON.stringify({ pid: process.pid, purpose: "live" });
  writeFileSync(file, content);
  assert.throws(() => unlockStale(dir, {}), { code: "locked", errorClass: "config" });
  assert.equal(readFileSync(file, "utf8"), content);
  assert.deepEqual(unlockStale(dir, { force: true }), { removed: true, forced: true });
  assert.equal(existsSync(file), false);
});

test("two processes both reject a dead-owner lock without entering", async () => {
  const dir = testTempDir("lock-processes");
  const file = path.join(dir, "lock");
  const entered = path.join(dir, "entered");
  const script = path.join(dir, "waiter.mjs");
  writeFileSync(file, stale);
  writeFileSync(
    script,
    `
import { appendFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(new URL("../src/core/lock.mjs", import.meta.url).href)};
try {
  await withLock(process.argv[2], "child", () => appendFileSync(process.argv[3], "entered\\n"));
  process.exitCode = 1;
} catch (error) {
  console.log(error.code);
  process.exitCode = error.code === "stale_lock" ? 0 : 2;
}
`,
  );
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, [script, dir, entered], { stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          assert.equal(code, 0, stderr);
          assert.equal(stdout.trim(), "stale_lock");
          resolve(undefined);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  await Promise.all(children);
  assert.equal(existsSync(entered), false);
  assert.deepEqual(readFileSync(file), Buffer.from(stale));
});

test("unlock CLI reports no lock, removes stale locks, refuses live owners and supports force", () => {
  const repo = makeRepo();
  try {
    const dir = stateDir(repo.root);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "lock");
    const cli = (...args) =>
      spawnSync(process.execPath, [BIN, ...args], { cwd: repo.root, encoding: "utf8" });
    const empty = cli("unlock");
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /repository is not locked/);
    writeFileSync(file, stale);
    const recovered = cli("unlock");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /stale repository lock removed/);
    assert.equal(existsSync(file), false);
    const live = JSON.stringify({ pid: process.pid, purpose: "live" });
    writeFileSync(file, live);
    const refused = cli("unlock");
    assert.equal(refused.status, 2);
    assert.ok(refused.stderr.includes(`pid ${process.pid}`));
    assert.equal(readFileSync(file, "utf8"), live);
    const forced = cli("unlock", "--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /removed with --force regardless of owner/);
    assert.equal(existsSync(file), false);
    assert.match(cli("help").stdout, /unlock \[--force\]/);
  } finally {
    repo.cleanup();
  }
});
