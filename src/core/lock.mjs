// @ts-check
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";

/**
 * An exclusive, per-repository lock file around ref mutations and `land`.
 * Stale locks fail closed and require explicit recovery with `apocha unlock`.
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

/** @param {string} content @returns {Record<string, any> | null} */
function parseOwner(content) {
  try {
    const owner = JSON.parse(content);
    return owner && typeof owner === "object" && !Array.isArray(owner) ? owner : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, any> | null} owner */
function liveOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0 && alive(owner.pid);
}

/**
 * Explicit recovery; callers must first confirm no repository command is running.
 * @param {string} stateDir
 * @param {{ force?: boolean }} [options]
 */
export function unlockStale(stateDir, { force = false } = {}) {
  const file = path.join(stateDir, "lock");
  let content;
  try {
    content = readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, forced: false };
    throw error;
  }
  const owner = parseOwner(content.toString("utf8"));
  if (!force && liveOwner(owner)) {
    throw new HarnessError(
      "config",
      "locked",
      `repository is locked by live pid ${owner.pid} (${owner.purpose ?? "unknown"})`,
    );
  }
  if (!force && !readFileSync(file).equals(content)) {
    throw new HarnessError(
      "infra",
      "lock_changed",
      "repository lock changed during unlock; leaving it in place",
    );
  }
  rmSync(file, { force: true });
  return { removed: true, forced: force };
}

/** @param {string} file @param {string} token */
function release(file, token) {
  try {
    if (parseOwner(readFileSync(file, "utf8"))?.token === token) rmSync(file, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * @template T
 * @param {string} stateDir `<git-common-dir>/apocha`
 * @param {string} purpose shown to a waiting process
 * @param {() => T | Promise<T>} body
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(stateDir, purpose, body, options = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, "lock");
  const token = randomUUID();
  const deadline = Date.now() + (options.waitMs ?? 30000);
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ token, pid: process.pid, purpose, at: new Date().toISOString() }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let content;
      try {
        content = readFileSync(file, "utf8");
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      const owner = parseOwner(content);
      if (!liveOwner(owner)) {
        throw new HarnessError(
          "infra",
          "stale_lock",
          `repository has a stale lock: pid ${owner?.pid ?? "?"}, purpose ${owner?.purpose ?? "unknown"}, time ${owner?.at ?? "unknown"}; confirm no apocha command is still running for this repository, then run "apocha unlock"`,
        );
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
    release(file, token);
  }
}
