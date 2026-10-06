// @ts-check
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfigAt } from "../config/project.mjs";
import { newRunId, RunStore, stateDir } from "../core/runs.mjs";
import { HarnessError } from "../util/errors.mjs";
import { writeJsonAtomic } from "../util/fs-safe.mjs";
import { isCanonicalRef, resolveCommit, git as runGit } from "../util/git.mjs";
import { verifyReceipt } from "./receipts.mjs";
import { verifyCommitReceipt } from "./verify-range.mjs";

/**
 * Fast-forward `target` to `source`, but only if every first-parent commit in
 * between carries a valid receipt. Never pushes. If the target branch is
 * checked out in a worktree, that worktree must be clean and is fast-forwarded
 * in place.
 *
 * @param {{ repositoryRoot: string, notesRef: string, source: string, target: string, batchPrefix?: string, keepBatch?: boolean, requireSigned?: boolean, onBeforeRetire?: () => void }} input
 */
export function landBranch(input) {
  const hooksPath = mkdtempSync(path.join(os.tmpdir(), "apocha-land-hooks-"));
  try {
    return landWithoutHooks(input, hooksPath);
  } finally {
    rmSync(hooksPath, { recursive: true, force: true });
  }
}

/** @param {Parameters<typeof landBranch>[0]} input @param {string} hooksPath */
function landWithoutHooks(
  {
    repositoryRoot,
    notesRef,
    source,
    target,
    batchPrefix = "refs/heads/apocha/batch/",
    keepBatch = false,
    requireSigned = false,
    onBeforeRetire,
  },
  hooksPath,
) {
  /** @param {string} cwd @param {string[]} args @param {Parameters<typeof runGit>[2]} [options] */
  const git = (cwd, args, options) => runGit(cwd, ["-c", `core.hooksPath=${hooksPath}`, ...args], options);
  /** @param {string} cwd @param {string[]} args */
  const gitText = (cwd, args) => String(git(cwd, args).stdout).trim();
  if (typeof target !== "string" || !target || target.startsWith("-") || target.startsWith("refs/")) {
    throw new HarnessError("config", "invalid_target", "target must be a branch name");
  }
  const ref = `refs/heads/${target}`;
  if (!isCanonicalRef(repositoryRoot, ref))
    throw new HarnessError("config", "invalid_target", `invalid branch name: ${target}`);
  const oldHead = resolveCommit(repositoryRoot, ref);
  if (!oldHead) throw new HarnessError("config", "unknown_target", `target branch does not exist: ${target}`);
  const config = loadProjectConfigAt(repositoryRoot, oldHead);
  requireSigned ||= config.receipts.require_signed;
  const newHead = resolveCommit(repositoryRoot, source);
  if (!newHead)
    throw new HarnessError("config", "unknown_source", `source does not resolve to a commit: ${source}`);
  const ancestor = git(repositoryRoot, ["merge-base", "--is-ancestor", oldHead, newHead], {
    allowFailure: true,
  });
  if (ancestor.status !== 0)
    throw new HarnessError("config", "not_fast_forward", "target is not an ancestor of source");
  const commits = gitText(repositoryRoot, ["rev-list", "--first-parent", `${oldHead}..${newHead}`])
    .split("\n")
    .filter(Boolean);
  const firstParentChain = gitText(repositoryRoot, ["rev-list", "--first-parent", newHead]).split("\n");
  if (!firstParentChain.includes(oldHead))
    throw new HarnessError("config", "not_first_parent", "target is not on the source's first-parent chain");
  const store = new RunStore(repositoryRoot);
  const runs = store.list();
  /** @type {Map<string, string>} */
  const candidates = new Map();
  const sourceRef = git(repositoryRoot, ["rev-parse", "--symbolic-full-name", "--verify", source], {
    allowFailure: true,
  });
  const sourceName = String(sourceRef.stdout).trim();
  if (sourceName) candidates.set(sourceName, newHead);
  const batchRefs = gitText(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    batchPrefix,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const landedCommits = new Set(
    gitText(repositoryRoot, ["rev-list", `${oldHead}..${newHead}`])
      .split("\n")
      .filter(Boolean),
  );
  for (const [name, oid] of batchRefs) {
    if (landedCommits.has(oid)) candidates.set(name, oid);
  }
  for (const commit of commits) {
    const check = verifyCommitReceipt(
      repositoryRoot,
      notesRef,
      commit,
      oldHead,
      config.receipts.allowed_signers,
      requireSigned,
    );
    if (!check.valid)
      throw new HarnessError(
        "integrity",
        check.code ?? "invalid_receipt",
        `commit ${commit} has no valid receipt: ${check.reason}`,
      );
    // Integration receipts name the topic commits as additional parents.
    for (const topic of check.receipt.parents.slice(1)) {
      for (const [name, oid] of batchRefs) {
        if (oid === topic) candidates.set(name, oid);
      }
      const topicReceipt = verifyReceipt(
        repositoryRoot,
        notesRef,
        topic,
        oldHead,
        config.receipts.allowed_signers,
      );
      for (const run of runs) {
        if (
          (run.promoted_head === topic ||
            (topicReceipt.valid && run.run_id === topicReceipt.receipt.run_id)) &&
          typeof run.batch_ref === "string"
        )
          candidates.set(run.batch_ref, topic);
      }
    }
  }
  const worktrees = gitText(repositoryRoot, ["worktree", "list", "--porcelain"]).split("\n\n");
  const checkout = worktrees.find((entry) => entry.split("\n").includes(`branch ${ref}`));
  if (checkout) {
    const worktree = checkout
      .split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (!worktree) throw new HarnessError("infra", "worktree_unknown", "target worktree path is unavailable");
    if (gitText(worktree, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new HarnessError(
        "config",
        "dirty_worktree",
        "the worktree that has the target checked out has tracked changes",
      );
    }
    if (gitText(worktree, ["rev-parse", "HEAD"]) !== oldHead)
      throw new HarnessError("integrity", "target_moved", "target moved during land");
    git(repositoryRoot, ["update-ref", "--no-deref", ref, newHead, oldHead]);
    try {
      git(worktree, ["read-tree", "-m", "-u", oldHead, newHead]);
    } catch (error) {
      const rollback = git(repositoryRoot, ["update-ref", "--no-deref", ref, oldHead, newHead], {
        allowFailure: true,
      });
      if (rollback.error || rollback.status !== 0)
        throw new HarnessError(
          "infra",
          "land_rollback_failed",
          `worktree update failed: ${String(error)}; target ref rollback failed: ${String(rollback.stderr)}`,
        );
      throw error;
    }
  } else {
    git(repositoryRoot, ["update-ref", "--no-deref", ref, newHead, oldHead]);
  }
  onBeforeRetire?.();
  /** @type {{ ref: string, oid: string }[]} */
  const retired = [];
  /** @type {{ ref: string, oid: string, reason: string }[]} */
  const kept = [];
  for (const [name, oid] of candidates) {
    let reason = null;
    if (keepBatch) reason = "keep-batch";
    else if (name === ref) reason = "target";
    else if (!name.startsWith(batchPrefix) || name.length <= batchPrefix.length)
      reason = "outside batch prefix";
    else if (git(repositoryRoot, ["symbolic-ref", "-q", name], { allowFailure: true }).status === 0)
      reason = "symbolic ref";
    else if (
      gitText(repositoryRoot, ["worktree", "list", "--porcelain"]).split("\n").includes(`branch ${name}`)
    )
      reason = "checked out in a worktree";
    else if (
      store
        .list()
        .some((run) => (run.outcome === "RUNNING" || run.outcome === "PAUSED") && run.batch_ref === name)
    )
      reason = "RUNNING or PAUSED run";
    else if (resolveCommit(repositoryRoot, name) !== oid) reason = "ref moved";
    else if (
      git(repositoryRoot, ["merge-base", "--is-ancestor", oid, newHead], { allowFailure: true }).status !== 0
    )
      reason = "not an ancestor of target";
    else {
      const deletion = git(repositoryRoot, ["update-ref", "--no-deref", "-d", name, oid], {
        allowFailure: true,
      });
      if (deletion.status !== 0) reason = "ref moved or deletion failed";
    }
    if (reason) kept.push({ ref: name, oid, reason });
    else retired.push({ ref: name, oid });
  }
  const result = { target, old_head: oldHead, new_head: newHead, commits, retired, kept };
  const directory = path.join(stateDir(repositoryRoot), "lands");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = path.join(directory, `${newRunId("land")}.json`);
  writeJsonAtomic(record, { ...result, created_at: new Date().toISOString() });
  return { ...result, record };
}
