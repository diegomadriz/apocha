// @ts-check

import { validateWorkflow } from "../core/workflow.mjs";
import { HarnessError } from "../util/errors.mjs";
import codeDelivery from "./code-delivery.mjs";
import integrate from "./integrate.mjs";

/** Built-in workflow definitions, validated at load. */
export const WORKFLOWS = Object.freeze({
  [codeDelivery.id]: validateWorkflow(codeDelivery),
  [integrate.id]: validateWorkflow(integrate),
});

/** @param {string} id */
export function getWorkflow(id) {
  const workflow = WORKFLOWS[id];
  if (!workflow) throw new HarnessError("config", "unknown_workflow", `unknown workflow: ${id}`);
  return workflow;
}
