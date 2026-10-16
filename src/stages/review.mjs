// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { effectiveProtectedPaths } from "../config/task.mjs";
import { snapshotCandidate } from "../git/candidate.mjs";
import { testEdits } from "../git/test-edits.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git } from "../util/git.mjs";
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
  if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
  if (_stage.mode === "blocked-claim") return runBlockedClaimReview(ctx);
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
  const testChanges = (verified.test_changes ?? []).map((entry) => ({
    ...entry,
    diff: String(
      git(ctx.candidate.root, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        snapshot.base_commit,
        "--",
        entry.path,
      ]).stdout,
    ),
  }));
  if (testChanges.some((entry) => Buffer.byteLength(entry.diff) > ctx.config.limits.review_diff_bytes)) {
    ctx.state.reason = "test change diff exceeds the review limit";
    ctx.event("review.skipped", { reason: ctx.state.reason });
    return "too_large";
  }
  const judgeInputChanges = (verified.judge_input_changes ?? []).map(({ reason, ...entry }) => ({
    ...entry,
    diff: String(
      git(ctx.candidate.root, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        snapshot.base_commit,
        "--",
        entry.path,
      ]).stdout,
    ),
  }));
  if (
    judgeInputChanges.some((entry) => Buffer.byteLength(entry.diff) > ctx.config.limits.review_diff_bytes)
  ) {
    ctx.state.reason = "judge input change diff exceeds the review limit";
    ctx.event("review.skipped", { reason: ctx.state.reason });
    return "too_large";
  }
  const bundle = {
    untrusted: {
      implementer_summary: ctx.state.implementation?.summary ?? null,
      implementer_uncertainties: ctx.state.implementation?.unresolved_uncertainties ?? [],
      criteria_claims: ctx.state.implementation?.criteria_evidence ?? [],
      judge_input_reasons: (verified.judge_input_changes ?? []).map(({ path, reason }) => ({
        path,
        declared_reason: reason,
      })),
    },
    judge_input_changes: judgeInputChanges,
    base_judge: verified.base_judge,
    criteria_evidence: ctx.task.acceptance_criteria.map((text, index) => ({
      criterion: index + 1,
      acceptance_criterion: text,
    })),
    test_changes: testChanges,
    refactors_to_check: testChanges
      .filter((entry) => entry.kind === "refactor" && entry.assertions_preserved === false)
      .map((entry) => ({
        path: entry.path,
        reason:
          "The assertion preservation heuristic did not match; review the diff for preserved coverage and possible bypasses.",
      })),
    undeclared_test_changes: tests.modified.filter(
      (file) => !(ctx.task.test_changes ?? []).some((entry) => entry.path === file),
    ),
    declared_test_changes: ctx.task.test_changes ?? [],
    tests_on_base: verified.tests_on_base ?? [],
    added_tests: tests.added,
    ...(tests.modified.length ? { modified_tests: tests.modified } : {}),
    task: { task_id: ctx.task.task_id, description: ctx.task.description },
    acceptance_criteria: ctx.task.acceptance_criteria,
    candidate: {
      base_commit: snapshot.base_commit,
      candidate_digest: snapshot.candidate_digest,
      changed_files: snapshot.changed_files,
      deleted_files: deletedPaths,
    },
    diff: snapshot.diff,
    verification: { checks: verified.checks.map((check) => ({ id: check.id, status: check.status })) },
    allowed_paths: ctx.task.allowed_paths,
    protected_paths: effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed),
    design_reference: designReference(ctx),
    ...(ctx.integration ? { integration: ctx.integration } : {}),
  };
  const provenance = {
    controller: [...Object.keys(bundle).filter((key) => key !== "untrusted" && key !== "diff"), "provenance"],
    untrusted: ["untrusted", "diff"],
    untrusted_paths: [
      ...(testChanges.length ? ["test_changes[].diff"] : []),
      ...(judgeInputChanges.length ? ["judge_input_changes[].diff"] : []),
    ],
  };
  const { result } = await invokeAgent(ctx, "reviewer", { ...bundle, provenance }, { deletedPaths });
  const after = snapshotCandidate(ctx.candidate);
  if (after.candidate_digest !== verified.candidate_digest)
    throw new HarnessError("integrity", "candidate_changed_in_review", "candidate changed during review");

  /** @type {string | null} */
  let invalid = null;
  if (result.candidate_digest !== verified.candidate_digest)
    invalid = "review names a different candidate digest";
  else if (result.decision === "PASS" && result.findings.some((finding) => finding.severity === "blocking"))
    invalid = "PASS with a blocking finding";
  else if (result.decision === "FIX" && !result.findings.length) invalid = "FIX without findings";
  else if (result.decision === "ESCALATE" && !result.reason) invalid = "ESCALATE without a reason";
  if (!invalid && result.decision === "PASS" && judgeInputChanges.length) {
    const verdicts = result.judge_input_verdicts ?? [];
    const missing = judgeInputChanges.find(
      (entry) =>
        verdicts.filter((verdict) => verdict.path === entry.path).length !== 1 ||
        !verdicts.some((verdict) => verdict.path === entry.path && verdict.verdict === "justified"),
    );
    const extra = verdicts.find((verdict) => !judgeInputChanges.some((entry) => entry.path === verdict.path));
    if (missing || extra) invalid = `PASS without a justified verdict for ${missing?.path ?? extra.path}`;
  }
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
    ...(result.judge_input_verdicts ? { judge_input_verdicts: result.judge_input_verdicts } : {}),
  };
  ctx.event("review.finished", { decision: result.decision, findings: result.findings.length });
  if (result.decision === "FIX") {
    ctx.state.findings = result.findings.map((finding) => ({ source: "review", ...finding }));
  }
  if (result.decision === "ESCALATE") ctx.state.reason = `reviewer escalated: ${result.reason}`;
  return result.decision;
}

/**
 * Review an impossibility claim without running checks on the candidate.
 * @param {import("../core/context.mjs").RunContext} ctx
 */
async function runBlockedClaimReview(ctx) {
  const snapshot = snapshotCandidate(ctx.candidate);
  if (Buffer.byteLength(snapshot.diff) > ctx.config.limits.review_diff_bytes) {
    ctx.state.reason = "blocked claim diff exceeds the review limit";
    ctx.event("review.skipped", { reason: ctx.state.reason });
    return "too_large";
  }
  const deletedPaths = snapshot.changed_files.filter(
    (file) => !existsSync(path.join(ctx.candidate.root, file)),
  );
  const bundle = {
    task: { task_id: ctx.task.task_id, description: ctx.task.description },
    acceptance_criteria: ctx.task.acceptance_criteria,
    allowed_paths: ctx.task.allowed_paths,
    read_only_paths: ctx.task.read_only_paths,
    protected_paths: effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed),
    untrusted: {
      implementer_summary: ctx.state.implementation?.summary ?? null,
      implementer_uncertainties: ctx.state.implementation?.unresolved_uncertainties ?? [],
      criteria_claims: ctx.state.implementation?.criteria_evidence ?? [],
      blocked_reason: ctx.state.implementation?.blocked_reason,
      blocked_summary: ctx.state.implementation?.summary,
      judge_input_reasons: (ctx.state.last_verification?.judge_input_changes ?? []).map(
        ({ path, reason }) => ({
          path,
          declared_reason: reason,
        }),
      ),
    },
    criteria_evidence: ctx.task.acceptance_criteria.map((text, index) => ({
      criterion: index + 1,
      acceptance_criterion: text,
    })),
    candidate: {
      base_commit: snapshot.base_commit,
      candidate_digest: snapshot.candidate_digest,
      changed_files: snapshot.changed_files,
      deleted_files: deletedPaths,
    },
    diff: snapshot.diff,
    verification: ctx.state.last_verification
      ? {
          ...ctx.state.last_verification,
          judge_input_changes: (ctx.state.last_verification.judge_input_changes ?? []).map(
            ({ reason, ...entry }) => entry,
          ),
        }
      : ctx.state.last_verification,
    design_reference: designReference(ctx),
    ...(ctx.integration ? { integration: ctx.integration } : {}),
  };
  const provenance = {
    controller: [...Object.keys(bundle).filter((key) => key !== "untrusted" && key !== "diff"), "provenance"],
    untrusted: ["untrusted", "diff"],
  };
  const { result } = await invokeAgent(ctx, "reviewer", { ...bundle, provenance }, { deletedPaths });
  if (snapshotCandidate(ctx.candidate).candidate_digest !== snapshot.candidate_digest)
    throw new HarnessError("integrity", "candidate_changed_in_review", "candidate changed during review");
  if (result.candidate_digest !== snapshot.candidate_digest)
    throw new HarnessError("integrity", "invalid_review", "review names a different candidate digest");
  if (result.decision === "ESCALATE" && !result.reason)
    throw new HarnessError("integrity", "invalid_review", "ESCALATE without a reason");

  const confirmed = result.decision === "ESCALATE";
  const decision = confirmed ? "ESCALATE" : "FIX";
  const findings =
    result.decision === "PASS" || (!confirmed && !result.findings.length)
      ? [
          ...result.findings,
          {
            id: "blocked-claim-not-confirmed",
            reason: "The blocked claim was not confirmed; complete the task within its rules.",
          },
        ]
      : result.findings;
  ctx.state.last_review = {
    decision,
    findings,
    reason: result.reason,
    candidate_digest: snapshot.candidate_digest,
  };
  ctx.event("review.finished", { decision, findings: findings.length, mode: "blocked-claim" });
  ctx.event(confirmed ? "blocked.confirmed" : "blocked.rejected", {
    decision: result.decision,
    reason: result.reason ?? null,
    findings,
  });
  ctx.state.blocked_claims ??= [];
  ctx.state.blocked_claims.push({
    blocked_reason: bundle.untrusted.blocked_reason,
    summary: bundle.untrusted.blocked_summary,
    decision: result.decision,
    confirmed,
    reviewer_reason: result.reason,
  });
  if (confirmed) {
    ctx.state.reason = `implementer reported blocked; reviewer confirmed: ${result.reason}`;
  } else {
    ctx.state.reason = null;
    ctx.state.findings = findings.map((finding) => ({ source: "review", ...finding }));
  }
  return decision;
}
