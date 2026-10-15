// @ts-check
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessError } from "./errors.mjs";

/**
 * Repository paths are POSIX, relative, NFC-normalized, and canonical.
 * A trailing "/" marks a directory scope ("src/" covers everything below src).
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function canonicalPath(value, label = "path") {
  const fail = (reason) => {
    throw new HarnessError("config", "invalid_path", `${label} ${reason}: ${JSON.stringify(value)}`);
  };
  if (typeof value !== "string" || value.length === 0) fail("must be a non-empty string");
  const text = /** @type {string} */ (value);
  if (/[\x00-\x1f\x7f\\]/.test(text) || text.includes("�")) fail("contains forbidden characters");
  if (text.normalize("NFC") !== text) fail("is not NFC-normalized");
  if (path.posix.isAbsolute(text)) fail("must be relative");
  const isDirectory = text.endsWith("/");
  const normalized = path.posix.normalize(text);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../"))
    fail("escapes the repository");
  if (normalized !== text && !(isDirectory && `${normalized}/` === text)) fail("is not canonical");
  return text;
}

/** True when any component is `.git` (case-insensitive). @param {string} value */
export function hasGitComponent(value) {
  return value.split("/").some((part) => part.toLowerCase() === ".git");
}

/**
 * Does `candidate` fall under `scope`? Directory scopes end in "/".
 * @param {string} candidate
 * @param {string} scope
 */
export function inScope(candidate, scope) {
  return scope.endsWith("/") ? candidate.startsWith(scope) : candidate === scope;
}

/** @param {string} candidate @param {readonly string[]} scopes */
export function inAnyScope(candidate, scopes) {
  return scopes.some((scope) => inScope(candidate, scope));
}

/**
 * Case-insensitive match against forbidden scopes, so `Private/` cannot dodge `private/`.
 * @param {string} candidate
 * @param {readonly string[]} forbidden
 */
export function isForbidden(candidate, forbidden) {
  const lower = candidate.toLowerCase();
  return hasGitComponent(candidate) || forbidden.some((scope) => inScope(lower, scope.toLowerCase()));
}

/**
 * Select forbidden files from the index used to materialize a check.
 * @param {readonly string[]} files
 * @param {readonly string[]} forbidden
 */
export function forbiddenMaterializedPaths(files, forbidden) {
  return files.filter((file) => isForbidden(file, forbidden));
}

/**
 * Include literal scopes and all existing case variants, resolving only their components.
 * Directory scopes need no traversal below the matched directory.
 * @param {string} root
 * @param {readonly string[]} forbidden
 * @returns {string[]}
 */
export function forbiddenDenyPaths(root, forbidden) {
  const denied = new Set();
  for (const scope of forbidden) {
    denied.add(path.resolve(root, scope));
    let parents = [root];
    for (const component of scope.replace(/\/$/, "").split("/")) {
      /** @type {string[]} */
      const matches = [];
      for (const parent of parents) {
        try {
          for (const name of readdirSync(parent)) {
            if (name.toLowerCase() === component.toLowerCase()) matches.push(path.join(parent, name));
          }
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
      }
      parents = matches;
    }
    for (const match of parents) denied.add(match);
  }
  return [...denied];
}

/** Expand a leading `~/` to the user's home directory. @param {string} value */
export function expandHome(value) {
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

/** @param {string} child @param {string} root */
export function isInside(child, root) {
  return child === root || child.startsWith(`${root}${path.sep}`);
}
