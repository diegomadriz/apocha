// @ts-check
import { spawnSync } from "node:child_process";
import { HarnessError } from "./errors.mjs";

export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Run git synchronously. Throws an `infra` HarnessError on failure unless
 * `allowFailure` is set, in which case the raw result is returned.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string | Buffer, env?: Record<string, string>, allowFailure?: boolean, encoding?: "utf8" | "buffer", maxBuffer?: number }} [options]
 */
export function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input: options.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.env ?? {}) },
    encoding: options.encoding === "buffer" ? undefined : "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
  if (options.allowFailure) return result;
  if (result.error || result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    const detail = result.error?.message ?? (stderr || `exit ${result.status}`);
    throw new HarnessError("infra", "git_failed", `git ${args[0]} failed: ${detail.slice(0, 500)}`);
  }
  return result;
}

/** @param {string} cwd @param {string[]} args @returns {string} */
export function gitText(cwd, args) {
  return String(git(cwd, args).stdout).trim();
}

/**
 * Resolve a ref to a full commit OID, or return null when it does not exist.
 * @param {string} cwd
 * @param {string} ref
 */
export function resolveCommit(cwd, ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) return null;
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  const oid = String(result.stdout ?? "").trim();
  return result.status === 0 && OID.test(oid) ? oid : null;
}

/** @param {string} cwd */
export function repositoryRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0)
    throw new HarnessError("config", "not_a_repository", "not inside a Git repository");
  return String(result.stdout).trim();
}

/** @param {string} cwd */
export function gitCommonDir(cwd) {
  const result = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return String(result.stdout).trim();
}

/**
 * Parse a commit object into its tree and parents.
 * @param {string} cwd
 * @param {string} commit
 */
export function commitIdentity(cwd, commit) {
  if (!OID.test(commit)) throw new HarnessError("config", "invalid_oid", "commit must be a full object id");
  const type = git(cwd, ["cat-file", "-t", commit], { allowFailure: true });
  if (type.status !== 0 || String(type.stdout).trim() !== "commit") {
    throw new HarnessError("config", "not_a_commit", `not a commit: ${commit}`);
  }
  const header = gitText(cwd, ["cat-file", "-p", commit]).split("\n\n", 1)[0].split("\n");
  const tree = header.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = header.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  return { tree, parents };
}

/**
 * Validate a full ref name (for example `refs/heads/apocha/batch/x`).
 * @param {string} cwd
 * @param {string} ref
 */
export function isCanonicalRef(cwd, ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/") || /[\s\\\x00-\x1f\x7f]/.test(ref)) return false;
  const result = git(cwd, ["check-ref-format", "--normalize", ref], { allowFailure: true });
  return result.status === 0 && String(result.stdout).trim() === ref;
}

/** @param {string} cwd @param {string} ref */
export function refExists(cwd, ref) {
  const result = git(cwd, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new HarnessError("infra", "git_failed", `cannot inspect ref ${ref}`);
}

/**
 * Compare-and-swap a ref. `oldOid` null means "must not exist".
 * @param {string} cwd
 * @param {string} ref
 * @param {string} newOid
 * @param {string | null} oldOid
 */
export function updateRef(cwd, ref, newOid, oldOid) {
  const zero = "0".repeat(newOid.length);
  git(cwd, ["update-ref", "--no-deref", ref, newOid, oldOid ?? zero]);
}

/** @param {string} cwd @param {string} ref @param {string} oldOid */
export function deleteRef(cwd, ref, oldOid) {
  return git(cwd, ["update-ref", "--no-deref", "-d", ref, oldOid], { allowFailure: true }).status === 0;
}

/** Configured user identity of a repository, required for promotion commits. */
export function configuredIdentity(cwd) {
  const read = (key) => {
    const result = git(cwd, ["config", "--get", key], { allowFailure: true });
    const value = String(result.stdout ?? "").replace(/\r?\n$/, "");
    if (result.status !== 0 || !value.trim()) {
      throw new HarnessError(
        "config",
        "git_identity_missing",
        `git ${key} must be configured in the repository`,
      );
    }
    return value;
  };
  return { name: read("user.name"), email: read("user.email") };
}

/**
 * Run git and return raw stdout bytes (for blobs and binary diffs).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Buffer}
 */
export function gitBuffer(cwd, args) {
  return /** @type {Buffer} */ (/** @type {unknown} */ (git(cwd, args, { encoding: "buffer" }).stdout));
}
