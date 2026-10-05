// @ts-check
import { realpathSync } from "node:fs";
import { HarnessError } from "../util/errors.mjs";
import {
  configuredIdentity,
  git,
  gitText,
  isCanonicalRef,
  OID,
  refExists,
  resolveCommit,
  updateRef,
} from "../util/git.mjs";
import { snapshotCandidate } from "./candidate.mjs";

/**
 * Batch refs hold promoted candidates. A run reserves its batch ref at the
 * base commit before any agent work (compare-and-swap from "absent"), and
 * promotion moves it from the base to the promoted commit (compare-and-swap
 * again). Nothing else writes these refs.
 */

/**
 * @param {string} repositoryRoot
 * @param {string} batchRef full ref name
 * @param {string} prefix configured batch prefix
 */
export function assertBatchRef(repositoryRoot, batchRef, prefix) {
  if (typeof batchRef !== "string" || !batchRef.startsWith(prefix) || batchRef.length <= prefix.length) {
    throw new HarnessError("config", "invalid_batch_ref", `batch ref must be under ${prefix}`);
  }
  if (!isCanonicalRef(repositoryRoot, batchRef))
    throw new HarnessError("config", "invalid_batch_ref", `batch ref is not canonical: ${batchRef}`);
  const symbolic = git(repositoryRoot, ["symbolic-ref", "-q", batchRef], { allowFailure: true });
  if (symbolic.status === 0)
    throw new HarnessError("config", "invalid_batch_ref", "batch ref must not be symbolic");
  const worktrees = String(git(repositoryRoot, ["worktree", "list", "--porcelain"]).stdout);
  if (worktrees.split("\n").includes(`branch ${batchRef}`)) {
    throw new HarnessError("config", "invalid_batch_ref", "batch ref must not be checked out in a worktree");
  }
  return batchRef;
}

/** @param {string} repositoryRoot @param {string} batchRef @param {string} baseCommit */
export function reserveBatchRef(repositoryRoot, batchRef, baseCommit) {
  if (refExists(repositoryRoot, batchRef))
    throw new HarnessError("config", "batch_ref_exists", `batch ref already exists: ${batchRef}`);
  updateRef(repositoryRoot, batchRef, baseCommit, null);
}

/**
 * Commit the verified candidate and move the batch ref to it.
 *
 * @param {{
 *   repositoryRoot: string,
 *   candidate: import("./candidate.mjs").Candidate,
 *   verifiedDigest: string,
 *   batchRef: string,
 *   message: string,
 *   additionalParents?: string[],
 *   timestamp?: Date,
 * }} input
 */
export function promoteCandidate({
  repositoryRoot,
  candidate,
  verifiedDigest,
  batchRef,
  message,
  additionalParents = [],
  timestamp = new Date(),
}) {
  const source = realpathSync(repositoryRoot);
  if (realpathSync(candidate.repository_root) !== source)
    throw new HarnessError("integrity", "wrong_repository", "candidate belongs to another repository");
  if (typeof message !== "string" || !message.trim() || message.includes("\0"))
    throw new HarnessError("config", "invalid_message", "commit message must be non-empty");
  const current = snapshotCandidate(candidate);
  if (current.candidate_digest !== verifiedDigest)
    throw new HarnessError("integrity", "stale_candidate", "candidate changed after verification");

  const oldHead = resolveCommit(source, batchRef);
  if (oldHead !== candidate.base_commit)
    throw new HarnessError(
      "integrity",
      "batch_ref_moved",
      "batch ref no longer points at the candidate base",
    );
  const parents = [oldHead];
  for (const parent of additionalParents) {
    if (!OID.test(parent) || parents.includes(parent))
      throw new HarnessError("config", "invalid_parent", "additional parents must be unique full OIDs");
    for (const root of [source, candidate.root]) {
      const type = git(root, ["cat-file", "-t", parent], { allowFailure: true });
      if (type.status !== 0 || String(type.stdout).trim() !== "commit")
        throw new HarnessError("config", "invalid_parent", `parent is not a commit: ${parent}`);
    }
    parents.push(parent);
  }

  const identity = configuredIdentity(source);
  const iso = timestamp.toISOString();
  const date = `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`;
  const tree = gitText(candidate.root, ["write-tree"]);
  const env = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: date,
    LC_ALL: "C",
    TZ: "UTC",
  };
  const head = String(
    git(
      candidate.root,
      [
        "-c",
        "commit.gpgSign=false",
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-F",
        "-",
      ],
      { env, input: message },
    ).stdout,
  ).trim();
  if (!OID.test(head)) throw new HarnessError("infra", "commit_failed", "commit-tree returned no object id");

  const transfer = `refs/panagent/transfer/${head}`;
  try {
    git(candidate.root, ["update-ref", transfer, head]);
    git(source, ["fetch", "--no-tags", "--quiet", candidate.root, transfer]);
  } finally {
    git(candidate.root, ["update-ref", "-d", transfer], { allowFailure: true });
  }
  git(source, ["cat-file", "-e", `${head}^{commit}`]);
  updateRef(source, batchRef, head, oldHead);
  return { old_head: oldHead, promoted_head: head, tree, parents };
}
