// @ts-check
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HarnessError } from "./errors.mjs";
import { canonicalPath, isInside } from "./paths.mjs";

/**
 * Resolve a repository-relative path inside `root`, refusing any symlink on
 * the way. Missing leaves are allowed when `allowMissing` is set; a missing
 * leaf can never bypass containment because every existing component is
 * checked with lstat.
 *
 * @param {string} root real (symlink-free) absolute root
 * @param {string} relative canonical repository path
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {{ absolute: string, exists: boolean }}
 */
export function resolveInside(root, relative, options = {}) {
  canonicalPath(relative);
  const absolute = path.resolve(root, relative);
  if (!isInside(absolute, root))
    throw new HarnessError("config", "path_escape", `path escapes root: ${relative}`);
  let cursor = root;
  for (const part of relative.split("/").filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        if (options.allowMissing) return { absolute, exists: false };
        throw new HarnessError("agent", "not_found", `path does not exist: ${relative}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new HarnessError("agent", "symlink", `symlinks are not allowed: ${relative}`);
  }
  return { absolute, exists: true };
}

/**
 * Read a regular file with a hard byte cap, guarding against FIFOs and
 * files that grow between stat and read.
 * @param {string} absolute
 * @param {number} maxBytes
 * @returns {Buffer}
 */
export function readRegularFile(absolute, maxBytes) {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HarnessError("agent", "not_a_file", "not a regular file");
    if (stat.size > maxBytes) throw new HarnessError("agent", "too_large", `file exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > maxBytes) throw new HarnessError("agent", "too_large", `file exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

/** A NUL byte in the first 8 KiB marks a file as binary. @param {Buffer} buffer */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Write JSON atomically (temp file + rename) with owner-only permissions.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Append one JSON line. @param {string} file @param {unknown} value */
export function appendJsonLine(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** realpath that returns null instead of throwing. @param {string} value */
export function realpathOrNull(value) {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

/**
 * First `bytes` bytes of a regular file (for binary sniffing).
 * @param {string} absolute
 * @param {number} [bytes]
 */
export function readHead(absolute, bytes = 8192) {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new HarnessError("agent", "not_a_file", "not a regular file");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
