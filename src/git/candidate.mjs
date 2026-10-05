// @ts-check
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git, gitBuffer, gitText, resolveCommit } from "../util/git.mjs";
import { canonicalPath, isInside } from "../util/paths.mjs";
import { makeTempDir, removeTempDir } from "../util/temp.mjs";

/**
 * A candidate is a private, no-hardlink clone of the source repository,
 * detached at the base commit with its origin removed. Agents edit it through
 * harness tools; the controller snapshots it into a content-addressed identity.
 *
 * @typedef {{ repository_root: string, root: string, base_commit: string, cleanup: () => void }} Candidate
 * @typedef {{ base_commit: string, changed_files: string[], diff: string, candidate_digest: string }} Snapshot
 */

/**
 * @param {string} repositoryRoot
 * @param {string} base ref or OID
 * @param {{ runId?: string }} [options]
 * @returns {Candidate}
 */
export function createCandidate(repositoryRoot, base, options = {}) {
  const repository = realpathSync(repositoryRoot);
  const baseCommit = resolveCommit(repository, base);
  if (!baseCommit)
    throw new HarnessError("config", "unknown_base", `base does not resolve to a commit: ${base}`);
  const workspace = makeTempDir("candidate", options);
  const root = path.join(workspace, "tree");
  try {
    git(repository, [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      "--no-tags",
      "--",
      repository,
      root,
    ]);
    git(root, ["remote", "remove", "origin"]);
    git(root, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", baseCommit]);
  } catch (error) {
    removeTempDir(workspace);
    throw error;
  }
  return attachCandidate(repository, root, baseCommit);
}

/**
 * Re-attach to an existing candidate directory (used when resuming a run).
 * @param {string} repository
 * @param {string} root
 * @param {string} baseCommit
 * @returns {Candidate}
 */
export function attachCandidate(repository, root, baseCommit) {
  let cleaned = false;
  return {
    repository_root: repository,
    root,
    base_commit: baseCommit,
    cleanup() {
      if (cleaned) return;
      removeTempDir(path.basename(root) === "tree" ? path.dirname(root) : root);
      if (existsSync(root)) throw new HarnessError("infra", "cleanup_failed", "candidate cleanup failed");
      cleaned = true;
    },
  };
}

/** @param {Candidate} candidate */
function rejectHiddenIndexState(candidate) {
  const entries = String(git(candidate.root, ["ls-files", "-v", "-z"]).stdout)
    .split("\0")
    .filter(Boolean);
  const hidden = entries.filter((entry) => entry[0] === "S" || /^[a-z]$/.test(entry[0]));
  if (hidden.length) {
    throw new HarnessError(
      "integrity",
      "hidden_index_state",
      `candidate uses skip-worktree or assume-unchanged: ${hidden.length} paths`,
    );
  }
}

/** @param {Candidate} candidate */
function rejectIgnoredFiles(candidate) {
  const ignored = String(
    git(candidate.root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).stdout,
  )
    .split("\0")
    .filter(Boolean);
  if (ignored.length) {
    throw new HarnessError(
      "integrity",
      "ignored_files",
      `ignored files are not allowed in a candidate: ${ignored.slice(0, 5).join(", ")}`,
    );
  }
}

/** @param {string} root @param {string} relative */
function inspectChangedPath(root, relative) {
  canonicalPath(relative, "changed path");
  const absolute = path.resolve(root, relative);
  if (!isInside(absolute, root))
    throw new HarnessError("integrity", "path_escape", `changed path escapes candidate: ${relative}`);
  if (!existsSync(absolute) && !isDanglingLink(absolute)) return;
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new HarnessError("integrity", "symlink", `candidate symlink rejected: ${relative}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.nlink > 1) {
    throw new HarnessError(
      "integrity",
      "special_file",
      `candidate special or hardlinked file rejected: ${relative}`,
    );
  }
}

/** @param {string} absolute */
function isDanglingLink(absolute) {
  try {
    return lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Stage everything and compute the candidate's identity:
 * sha256 over the base commit, the sorted changed paths, and the full binary diff.
 * @param {Candidate} candidate
 * @returns {Snapshot}
 */
export function snapshotCandidate(candidate) {
  rejectHiddenIndexState(candidate);
  rejectIgnoredFiles(candidate);
  git(candidate.root, ["add", "--all"]);
  return identityFromIndex(candidate.root, candidate.base_commit, (relative) =>
    inspectChangedPath(candidate.root, relative),
  );
}

/**
 * Identity of the staged index in `root` relative to `baseCommit`.
 * @param {string} root
 * @param {string} baseCommit
 * @param {(relative: string) => void} [inspect]
 * @returns {Snapshot}
 */
function identityFromIndex(root, baseCommit, inspect = () => {}) {
  const names = String(
    git(root, ["diff", "--cached", "--no-renames", "--name-only", "-z", baseCommit, "--"]).stdout,
  );
  const changedFiles = names
    .split("\0")
    .filter(Boolean)
    .map((name) => canonicalPath(name, "changed path"))
    .sort();
  changedFiles.forEach(inspect);
  const diff = diffText(root, ["diff", "--cached", baseCommit]);
  return {
    base_commit: baseCommit,
    changed_files: changedFiles,
    diff,
    candidate_digest: identityDigest(baseCommit, changedFiles, diff),
  };
}

/** @param {string} root @param {string[]} prefix */
function diffText(root, prefix) {
  return String(
    git(root, [...prefix, "--no-renames", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--"])
      .stdout,
  ).replaceAll("\r\n", "\n");
}

/** @param {string} baseCommit @param {string[]} changedFiles @param {string} diff */
export function identityDigest(baseCommit, changedFiles, diff) {
  return sha256(JSON.stringify({ base_commit: baseCommit, changed_files: changedFiles, diff }));
}

/**
 * Recompute a candidate digest from two commits, so a receipt can be checked
 * against Git alone.
 * @param {string} repositoryRoot
 * @param {string} baseCommit
 * @param {string} headCommit
 */
export function digestBetweenCommits(repositoryRoot, baseCommit, headCommit) {
  const names = String(
    git(repositoryRoot, ["diff", "--no-renames", "--name-only", "-z", baseCommit, headCommit, "--"]).stdout,
  );
  const changedFiles = names.split("\0").filter(Boolean).sort();
  const diff = diffText(repositoryRoot, ["diff", baseCommit, headCommit]);
  return identityDigest(baseCommit, changedFiles, diff);
}

/**
 * Read a file as it was at the base commit. Returns null when absent.
 * @param {Candidate} candidate
 * @param {string} relative
 * @param {number} maxBytes
 * @returns {Buffer | null}
 */
export function readBaseFile(candidate, relative, maxBytes) {
  canonicalPath(relative);
  const listed = git(candidate.root, ["ls-tree", "-l", "-z", candidate.base_commit, "--", relative]);
  const entry = String(listed.stdout).split("\0").find(Boolean);
  if (!entry) return null;
  const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t/.exec(entry);
  if (match?.[2] !== "blob") throw new HarnessError("agent", "not_a_file", `not a file at base: ${relative}`);
  if (match[1] === "120000") throw new HarnessError("agent", "symlink", `symlink at base: ${relative}`);
  if (Number(match[4]) > maxBytes)
    throw new HarnessError("agent", "too_large", `base file exceeds ${maxBytes} bytes: ${relative}`);
  return gitBuffer(candidate.root, ["cat-file", "blob", match[3]]);
}

/** Current HEAD of a candidate clone (equals the base until promotion). @param {Candidate} candidate */
export function candidateHead(candidate) {
  return gitText(candidate.root, ["rev-parse", "HEAD"]);
}
