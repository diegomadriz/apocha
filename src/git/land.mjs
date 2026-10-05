// @ts-check
import { HarnessError } from "../util/errors.mjs";
import { git, gitText, isCanonicalRef, resolveCommit, updateRef } from "../util/git.mjs";
import { verifyReceipt } from "./receipts.mjs";

/**
 * Fast-forward `target` to `source`, but only if every first-parent commit in
 * between carries a valid receipt. Never pushes. If the target branch is
 * checked out in a worktree, that worktree must be clean and is fast-forwarded
 * in place.
 *
 * @param {{ repositoryRoot: string, notesRef: string, source: string, target: string }} input
 */
export function landBranch({ repositoryRoot, notesRef, source, target }) {
  if (typeof target !== "string" || !target || target.startsWith("-") || target.startsWith("refs/")) {
    throw new HarnessError("config", "invalid_target", "target must be a branch name");
  }
  const ref = `refs/heads/${target}`;
  if (!isCanonicalRef(repositoryRoot, ref))
    throw new HarnessError("config", "invalid_target", `invalid branch name: ${target}`);
  const oldHead = resolveCommit(repositoryRoot, ref);
  if (!oldHead) throw new HarnessError("config", "unknown_target", `target branch does not exist: ${target}`);
  const newHead = resolveCommit(repositoryRoot, source);
  if (!newHead)
    throw new HarnessError("config", "unknown_source", `source does not resolve to a commit: ${source}`);
  if (oldHead === newHead) return { target, old_head: oldHead, new_head: newHead, commits: [] };
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
  for (const commit of commits) {
    const check = verifyReceipt(repositoryRoot, notesRef, commit);
    if (!check.valid)
      throw new HarnessError(
        "integrity",
        "invalid_receipt",
        `commit ${commit.slice(0, 12)} has no valid receipt: ${check.reason}`,
      );
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
    git(worktree, ["merge", "--ff-only", "--quiet", newHead]);
  } else {
    updateRef(repositoryRoot, ref, newHead, oldHead);
  }
  return { target, old_head: oldHead, new_head: newHead, commits };
}
