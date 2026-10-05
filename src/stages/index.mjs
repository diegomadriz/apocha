// @ts-check
import { HarnessError } from "../util/errors.mjs";
import { runImplementStage } from "./agent.mjs";
import { runChecksStage } from "./checks.mjs";
import { runPromoteStage } from "./promote.mjs";
import { runReviewStage } from "./review.mjs";
import { runMergeSeedStage } from "./seed.mjs";

/** Raised by a `human` stage that has no decision yet; the run pauses. */
export class AwaitingHuman extends Error {
  /** @param {string} stage */
  constructor(stage) {
    super(`awaiting a human decision at ${stage}`);
    this.name = "AwaitingHuman";
    this.stage = stage;
  }
}

/**
 * `budget` stage: spend one unit of a counter, or report it exhausted.
 * The `repairs` counter is bounded by the task's max_repair_attempts.
 * @param {import("../core/workflow.mjs").StageDefinition} stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
function runBudgetStage(stage, ctx) {
  const counter = /** @type {string} */ (stage.counter);
  const limit = counter === "repairs" ? ctx.task.max_repair_attempts : 0;
  const used = ctx.state.counters[counter] ?? 0;
  if (used >= limit) {
    ctx.state.reason = `${counter} budget exhausted (${used}/${limit})`;
    return "exhausted";
  }
  ctx.state.counters[counter] = used + 1;
  ctx.event("budget.spent", { counter, used: used + 1, limit });
  return "available";
}

/**
 * `human` stage: wait for an approve or reject decision given through
 * `panagent resume <run> --decision approve|reject`.
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 * @param {string} name
 */
function runHumanStage(_stage, ctx, name) {
  const decision = ctx.state.decisions[name];
  if (!decision) throw new AwaitingHuman(name);
  delete ctx.state.decisions[name];
  ctx.event("human.decided", { stage: name, decision });
  return decision;
}

/** @type {Record<string, (stage: any, ctx: any, name: string) => string | Promise<string>>} */
export const STAGE_KINDS = {
  seed: runMergeSeedStage,
  agent: runImplementStage,
  checks: runChecksStage,
  budget: runBudgetStage,
  review: runReviewStage,
  human: runHumanStage,
  promote: runPromoteStage,
};

/** @param {string} kind */
export function stageRunner(kind) {
  const runner = STAGE_KINDS[kind];
  if (!runner) throw new HarnessError("config", "unknown_stage_kind", `unknown stage kind: ${kind}`);
  return runner;
}
