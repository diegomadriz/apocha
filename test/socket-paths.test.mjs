// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { socketTempDir, testTempDir } from "./helpers.mjs";

test("Unix socket fixtures select /tmp when TMPDIR is too long", () => {
  const temporary = path.join(testTempDir("long-tmp"), "x".repeat(100));
  mkdirSync(temporary);
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = temporary;
    const parent = socketTempDir("daemon.sock");
    assert.equal(parent, realpathSync("/tmp"));
    assert.ok(Buffer.byteLength(path.join(parent, "apocha-ipc-XXXXXX", "daemon.sock")) < 100);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("Unix socket fixtures select the OS temp directory when it fits", () => {
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = "/tmp";
    assert.equal(socketTempDir("daemon.sock"), realpathSync("/tmp"));
    assert.throws(() => socketTempDir("x".repeat(100)), /100-byte safety limit/);
    // UTF-8 bytes, rather than JavaScript string length, determine whether paths fit.
    assert.throws(() => socketTempDir("é".repeat(50)), /100-byte safety limit/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
