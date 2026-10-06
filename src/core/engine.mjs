// @ts-check
import { AwaitingHuman, stageRunner } from "../stages/index.mjs";
import { describeError, HarnessError } from "../util/errors.mjs";
import { TERMINAL_STATES } from "./workflow.mjs";

/**
 * The engine: run stages from `ctx.state.stage` until a terminal state or a
 * pause. Only the engine changes `ctx.state.stage`; stages return an outcome
 * and the workflow's `on` table decides the next stage.
 *
 * Errors map to run outcomes:
 * - usage limits and human gates pause the run (resumable, same stage);
 * - agent, integrity, and policy errors escalate to a human;
 * - config, infra, provider, and tool-protocol errors end the run as ERROR.
 *
 * @param {import("./context.mjs").RunContext} ctx
 * @returns {Promise<{ outcome: "PASSED" | "FAILED" | "ESCALATED" | "PAUSED" | "ERROR", reason: string | null }>}
 */
export async function runEngine(ctx) {
  const definition = ctx.workflow;
  while (!TERMINAL_STATES.includes(ctx.state.stage)) {
    const name = ctx.state.stage;
    const stage = definition.stages[name];
    if (!stage)
      throw new HarnessError("config", "unknown_stage", `workflow ${definition.id} has no stage ${name}`);
    ctx.event("stage.started", { stage: name, kind: stage.kind });
    let outcome;
    try {
      if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
      outcome = await stageRunner(stage.kind)(stage, ctx, name);
      if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
    } catch (error) {
      return handleStageError(
        ctx,
        name,
        ctx.signal?.aborted ? new HarnessError("infra", "aborted", "run aborted") : error,
      );
    }
    const next = stage.on[outcome];
    if (!next) {
      return handleStageError(
        ctx,
        name,
        new HarnessError("config", "unrouted_outcome", `stage ${name} produced unrouted outcome ${outcome}`),
      );
    }
    ctx.event("stage.completed", {
      stage: name,
      outcome,
      next,
      ...(stage.kind === "checks" ? { duration_ms: ctx.state.last_verification?.duration_ms } : {}),
    });
    ctx.state.stage = next;
    if (TERMINAL_STATES.includes(next) && !ctx.state.reason && next !== "PASSED")
      ctx.state.reason = `${name}: ${outcome}`;
    ctx.persist();
  }
  return {
    outcome: /** @type {"PASSED" | "FAILED" | "ESCALATED"} */ (ctx.state.stage),
    reason: ctx.state.stage === "PASSED" ? null : ctx.state.reason,
  };
}

/**
 * @param {import("./context.mjs").RunContext} ctx
 * @param {string} stage
 * @param {unknown} error
 */
function handleStageError(ctx, stage, error) {
  if (error instanceof AwaitingHuman) {
    ctx.state.awaiting = error.stage;
    ctx.state.reason = error.message;
    ctx.event("run.paused", { stage, awaiting: error.stage });
    ctx.persist();
    return { outcome: /** @type {const} */ ("PAUSED"), reason: error.message };
  }
  const detail = describeError(error);
  ctx.state.error = { stage, ...detail };
  ctx.event("stage.failed", { stage, ...detail });
  if (detail.error_class === "usage_limited") {
    ctx.state.reason = `usage limit reached${detail.retry_after ? `; retry after ${detail.retry_after}` : ""}`;
    ctx.event("run.paused", { stage, reason: ctx.state.reason });
    ctx.persist();
    return { outcome: /** @type {const} */ ("PAUSED"), reason: ctx.state.reason };
  }
  ctx.state.reason = `${stage}: ${detail.error_class}/${detail.code}: ${detail.message}`;
  ctx.persist();
  const escalate = ["agent", "integrity", "policy_violation"].includes(detail.error_class);
  return {
    outcome: escalate ? /** @type {const} */ ("ESCALATED") : /** @type {const} */ ("ERROR"),
    reason: ctx.state.reason,
  };
}
