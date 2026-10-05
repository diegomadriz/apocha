// @ts-check
import { HarnessError, isObject } from "../util/errors.mjs";

/**
 * Workflows are data: a start stage and a map of stages. Each stage has a
 * `kind` (a primitive the engine knows how to run) and an `on` table from the
 * stage's outcome to the next stage or a terminal state. The engine is the
 * only thing that moves a run between stages.
 *
 * @typedef {{ kind: string, role?: "implementer" | "reviewer", counter?: string, prompt?: string, on: Record<string, string> }} StageDefinition
 * @typedef {{ id: string, version: number, description?: string, start: string, stages: Record<string, StageDefinition> }} WorkflowDefinition
 */

export const TERMINAL_STATES = Object.freeze(["PASSED", "FAILED", "ESCALATED"]);

/** Outcomes each stage kind can produce. A workflow must route every one. */
export const STAGE_OUTCOMES = Object.freeze({
  seed: ["done", "conflict", "empty"],
  agent: ["done", "no_changes"],
  checks: ["pass", "fail", "violation", "infra_error"],
  budget: ["available", "exhausted"],
  review: ["PASS", "FIX", "ESCALATE", "too_large"],
  human: ["approve", "reject"],
  promote: ["done"],
});

/**
 * Validate a workflow definition: known kinds, every outcome routed, every
 * target defined, every stage reachable, and a terminal state reachable.
 * @param {unknown} definition
 * @returns {WorkflowDefinition}
 */
export function validateWorkflow(definition) {
  const fail = (message) => {
    throw new HarnessError("config", "invalid_workflow", message);
  };
  if (!isObject(definition)) fail("workflow must be an object");
  const def = /** @type {WorkflowDefinition} */ (definition);
  if (typeof def.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(def.id)) fail("workflow id is invalid");
  if (!isObject(def.stages) || !Object.keys(def.stages).length) fail(`${def.id}: stages are required`);
  if (!Object.hasOwn(def.stages, def.start)) fail(`${def.id}: start stage '${def.start}' is not defined`);
  for (const [name, stage] of Object.entries(def.stages)) {
    if (TERMINAL_STATES.includes(name)) fail(`${def.id}: stage name '${name}' is reserved`);
    const outcomes = STAGE_OUTCOMES[stage.kind];
    if (!outcomes) fail(`${def.id}.${name}: unknown stage kind '${stage.kind}'`);
    if (
      (stage.kind === "agent" || stage.kind === "review") &&
      !["implementer", "reviewer"].includes(stage.role ?? "")
    ) {
      fail(`${def.id}.${name}: ${stage.kind} stages need a role`);
    }
    if (stage.kind === "budget" && !stage.counter) fail(`${def.id}.${name}: budget stages need a counter`);
    for (const outcome of outcomes) {
      if (!Object.hasOwn(stage.on ?? {}, outcome))
        fail(`${def.id}.${name}: outcome '${outcome}' is not routed`);
    }
    for (const [outcome, target] of Object.entries(stage.on)) {
      if (!outcomes.includes(outcome))
        fail(`${def.id}.${name}: '${outcome}' is not an outcome of ${stage.kind}`);
      if (!TERMINAL_STATES.includes(target) && !Object.hasOwn(def.stages, target))
        fail(`${def.id}.${name}: unknown target '${target}'`);
    }
  }
  const seen = new Set();
  const queue = [def.start];
  let terminalReachable = false;
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (seen.has(name)) continue;
    seen.add(name);
    for (const target of Object.values(def.stages[name].on)) {
      if (TERMINAL_STATES.includes(target)) terminalReachable = true;
      else queue.push(target);
    }
  }
  const unreachable = Object.keys(def.stages).filter((name) => !seen.has(name));
  if (unreachable.length) fail(`${def.id}: unreachable stages: ${unreachable.join(", ")}`);
  if (!terminalReachable) fail(`${def.id}: no terminal state is reachable`);
  return def;
}
