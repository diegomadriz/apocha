// @ts-check
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";

/**
 * An exclusive, per-repository lock file around ref mutations and `land`.
 * Stale locks (owner process gone) are recovered automatically.
 */

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * @template T
 * @param {string} stateDir `<git-common-dir>/panagent`
 * @param {string} purpose shown to a waiting process
 * @param {() => T | Promise<T>} body
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(stateDir, purpose, body, options = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, "lock");
  const deadline = Date.now() + (options.waitMs ?? 30000);
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, purpose, at: new Date().toISOString() }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      if (owner && Number.isInteger(owner.pid) && !alive(owner.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new HarnessError(
          "infra",
          "locked",
          `repository is locked by pid ${owner?.pid ?? "?"} (${owner?.purpose ?? "unknown"})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await body();
  } finally {
    closeSync(fd);
    rmSync(file, { force: true });
  }
}
