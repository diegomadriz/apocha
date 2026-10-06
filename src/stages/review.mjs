// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { effectiveProtectedPaths } from "../config/task.mjs";
import { snapshotCandidate } from "../git/candidate.mjs";
import { testEdits } from "../git/test-edits.mjs";
import { HarnessError } from "../util/errors.mjs";
import { designReference } from "./agent.mjs";
import { invokeAgent } from "./invoke.mjs";

/**
 * `review` stage: an independent reviewer judges the verified candidate. It
 * sees the full diff (B1); a diff above the configured limit escalates rather
 * than being truncated. The decision is bound to the candidate digest,
 * and the candidate is re-checked after review.
 *
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runReviewStage(_stage, ctx) {
  const verified = ctx.state.last_verification;
  if (verified?.status !== "pass")
    throw new HarnessError("integrity", "unverified", "review requires a passing verification");
  const snapshot = snapshotCandidate(ctx.candidate);
  if (snapshot.candidate_digest !== verified.candidate_digest)
    throw new HarnessError("integrity", "stale_verification", "candidate changed after verification");
  const diffBytes = Buffer.byteLength(snapshot.diff);
  if (diffBytes > ctx.config.limits.review_diff_bytes) {
    ctx.state.reason = `diff is ${diffBytes} bytes, above the review limit of ${ctx.config.limits.review_diff_bytes}`;
    ctx.event("review.skipped", { reason: ctx.state.reason });
    return "too_large";
  }
  const deletedPaths = snapshot.changed_files.filter(
    (file) => !existsSync(path.join(ctx.candidate.root, file)),
  );
  const tests = testEdits(ctx.candidate, ctx.config, snapshot.changed_files, ctx.task.test_edits);
  const bundle = {
    added_tests: tests.added,
    ...(tests.modified.length ? { modified_tests: tests.modified } : {}),
    task: { task_id: ctx.task.task_id, description: ctx.task.description },
    acceptance_criteria: ctx.task.acceptance_criteria,
    candidate: {
      base_commit: snapshot.base_commit,
      candidate_digest: snapshot.candidate_digest,
      changed_files: snapshot.changed_files,
      deleted_files: deletedPaths,
      implementer_summary: ctx.state.implementation?.summary ?? null,
      implementer_uncertainties: ctx.state.implementation?.unresolved_uncertainties ?? [],
    },
    diff: snapshot.diff,
    verification: { checks: verified.checks.map((check) => ({ id: check.id, status: check.status })) },
    allowed_paths: ctx.task.allowed_paths,
    protected_paths: effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed),
    design_reference: designReference(ctx),
    ...(ctx.integration ? { integration: ctx.integration } : {}),
  };
  const { result } = await invokeAgent(ctx, "reviewer", bundle, { deletedPaths });
  const after = snapshotCandidate(ctx.candidate);
  if (after.candidate_digest !== verified.candidate_digest)
    throw new HarnessError("integrity", "candidate_changed_in_review", "candidate changed during review");

  /** @type {string | null} */
  let invalid = null;
  if (result.candidate_digest !== verified.candidate_digest)
    invalid = "review names a different candidate digest";
  else if (result.decision === "FIX" && !result.findings.length) invalid = "FIX without findings";
  else if (result.decision === "ESCALATE" && !result.reason) invalid = "ESCALATE without a reason";
  if (invalid) {
    ctx.state.last_review = {
      decision: "ESCALATE",
      findings: [],
      reason: `invalid review: ${invalid}`,
      candidate_digest: verified.candidate_digest,
    };
    ctx.state.reason = ctx.state.last_review.reason;
    ctx.event("review.finished", { decision: "ESCALATE", invalid });
    return "ESCALATE";
  }
  ctx.state.last_review = {
    decision: result.decision,
    findings: result.findings,
    reason: result.reason,
    candidate_digest: result.candidate_digest,
  };
  ctx.event("review.finished", { decision: result.decision, findings: result.findings.length });
  if (result.decision === "FIX") {
    ctx.state.findings = result.findings.map((finding) => ({ source: "review", ...finding }));
  }
  if (result.decision === "ESCALATE") ctx.state.reason = `reviewer escalated: ${result.reason}`;
  return result.decision;
}
