// @ts-check
import { withLock } from "../core/lock.mjs";
import { promoteCandidate } from "../git/promotion.mjs";
import { RECEIPT_SCHEMA, writeReceipt } from "../git/receipts.mjs";
import { testEdits } from "../git/test-edits.mjs";
import { HarnessError } from "../util/errors.mjs";
import { GENERATOR } from "../version.mjs";

/**
 * `promote` stage: commit the reviewed candidate onto its batch ref and write
 * the receipt, under the repository lock.
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runPromoteStage(_stage, ctx) {
  const verified = ctx.state.last_verification;
  const review = ctx.state.last_review;
  if (verified?.status !== "pass")
    throw new HarnessError("integrity", "unverified", "promotion requires a passing verification");
  if (review?.decision !== "PASS" || review.candidate_digest !== verified.candidate_digest) {
    throw new HarnessError(
      "integrity",
      "unreviewed",
      "promotion requires a PASS review of the verified candidate",
    );
  }
  const checks = verified.checks
    .filter((check) => check.definition_digest)
    .map((check) => {
      if (check.status !== "pass")
        throw new HarnessError("integrity", "check_not_passed", `check ${check.id} did not pass`);
      return {
        id: check.id,
        status: "pass",
        definition_digest: /** @type {string} */ (check.definition_digest),
        sandbox: /** @type {string} */ (check.sandbox),
      };
    });
  const { policy, added, modified } = testEdits(
    ctx.candidate,
    ctx.config,
    verified.changed_files,
    ctx.task.test_edits,
  );
  return withLock(ctx.stateDir, `promote ${ctx.runId}`, () => {
    const promotion = promoteCandidate({
      repositoryRoot: ctx.repositoryRoot,
      candidate: ctx.candidate,
      verifiedDigest: verified.candidate_digest,
      batchRef: ctx.batchRef,
      message: ctx.message,
      additionalParents: ctx.additionalParents,
    });
    ctx.state.promotion = promotion;
    ctx.event("promotion.finished", { promoted_head: promotion.promoted_head, batch_ref: ctx.batchRef });
    const runtimeConfigDigests = ctx.store.read(ctx.runId).runtime_config_digests ?? [];
    const receipt = {
      schema: RECEIPT_SCHEMA,
      generator: { ...GENERATOR },
      workflow: ctx.workflow.id,
      run_id: ctx.runId,
      task_id: ctx.task.task_id,
      task_digest: ctx.taskDigest,
      promoted_head: promotion.promoted_head,
      tree: promotion.tree,
      parents: promotion.parents,
      base_commit: promotion.old_head,
      candidate_digest: verified.candidate_digest,
      checks,
      tests: {
        policy,
        added,
        modified,
        ...(ctx.config.tests.run_files ? { on_base: verified.tests_on_base ?? [] } : {}),
      },
      review: { decision: "PASS", findings: review.findings.length },
      repairs: ctx.state.counters.repairs ?? 0,
      agent_invocations: ctx.state.invocations,
      retries: ctx.state.retries,
      runtimes: {
        implementer: ctx.state.runtimes.implementer ?? null,
        reviewer: ctx.state.runtimes.reviewer ?? null,
      },
      config_digest: ctx.config.digest,
      runtime_config_digest: ctx.runtimes.digest,
      ...(runtimeConfigDigests.length > 1 ? { runtime_config_digests: runtimeConfigDigests } : {}),
      policy_digest: ctx.policyDigest,
      governance: { ...ctx.governance },
    };
    writeReceipt(ctx.repositoryRoot, ctx.config.refs.notes, receipt);
    ctx.event("receipt.written", { commit: promotion.promoted_head, notes_ref: ctx.config.refs.notes });
    return "done";
  });
}
