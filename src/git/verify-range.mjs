// @ts-check
import { loadProjectConfigAt } from "../config/project.mjs";
import { HarnessError } from "../util/errors.mjs";
import { gitText, resolveCommit } from "../util/git.mjs";
import { verifyReceipt } from "./receipts.mjs";

/**
 * Shared receipt policy for landing and range verification.
 * @param {string} repositoryRoot
 * @param {string} notesRef
 * @param {string} commit
 * @param {string} base
 * @param {string} allowedSigners
 * @param {boolean} requireSigned
 */
export function verifyCommitReceipt(repositoryRoot, notesRef, commit, base, allowedSigners, requireSigned) {
  const check = verifyReceipt(repositoryRoot, notesRef, commit, base, allowedSigners);
  if (requireSigned && check.signature.status !== "valid")
    return {
      ...check,
      valid: false,
      code: check.signature.status === "unsigned" ? "unsigned_receipt" : "bad_signature",
      reason: `receipt signature: ${check.signature.status}`,
    };
  return { ...check, code: check.valid ? null : "invalid_receipt" };
}

/**
 * Verify all first-parent commits of head not reachable from base, oldest first.
 * Trust configuration and signers only from base.
 * @param {{ repositoryRoot: string, base: string, head: string, requireSigned?: boolean }} input
 */
export function verifyRange({ repositoryRoot, base, head, requireSigned = false }) {
  const baseCommit = resolveCommit(repositoryRoot, base);
  const headCommit = resolveCommit(repositoryRoot, head);
  if (!baseCommit || !headCommit)
    throw new HarnessError("config", "unknown_commit", `not a commit: ${!baseCommit ? base : head}`);
  const config = loadProjectConfigAt(repositoryRoot, baseCommit);
  requireSigned ||= config.receipts.require_signed;
  const commits = gitText(repositoryRoot, [
    "rev-list",
    "--reverse",
    "--first-parent",
    `${baseCommit}..${headCommit}`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((commit) => {
      const check = verifyCommitReceipt(
        repositoryRoot,
        config.refs.notes,
        commit,
        baseCommit,
        config.receipts.allowed_signers,
        requireSigned,
      );
      return { commit, valid: check.valid, reason: check.reason, signature: check.signature };
    });
  const firstFailure = commits.find((check) => !check.valid);
  return {
    base: baseCommit,
    head: headCommit,
    require_signed: requireSigned,
    valid: !firstFailure,
    first_failing_commit: firstFailure?.commit ?? null,
    commits,
  };
}

/** @param {ReturnType<typeof verifyRange>} result */
export function formatRangeMarkdown(result) {
  const escapeMarkdown = (/** @type {string} */ text) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll("|", "&#124;")
      .replace(/[\r\n]/g, " ");
  return [
    "## Apocha receipt verification",
    "",
    result.valid ? "All commits valid." : `First failing commit: ${result.first_failing_commit}`,
    "",
    "| Commit | Result | Signature |",
    "| --- | --- | --- |",
    ...result.commits.map(
      (check) =>
        `| ${check.commit} | ${escapeMarkdown(check.valid ? "valid" : (check.reason ?? "invalid"))} | ${check.signature.status} |`,
    ),
    "",
  ].join("\n");
}
