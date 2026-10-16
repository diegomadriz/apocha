// @ts-check
import { effectiveProtectedPaths } from "../config/task.mjs";
import { readBaseFile, snapshotCandidate } from "../git/candidate.mjs";
import { HarnessError } from "../util/errors.mjs";
import { looksBinary, readRegularFile, resolveInside } from "../util/fs-safe.mjs";
import { invokeAgent } from "./invoke.mjs";

const CONTEXT_BYTES = 100000;
const DESIGN_BYTES = 150000;

/**
 * Files named in the task's initial_context, read from the candidate's
 * current state, bounded in total size.
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export function initialContext(ctx) {
  let budget = CONTEXT_BYTES;
  return ctx.task.initial_context.map((relative) => {
    const { absolute, exists } = resolveInside(ctx.candidate.root, relative, { allowMissing: true });
    if (!exists) return { path: relative, missing: true, content: "" };
    try {
      const buffer = readRegularFile(absolute, Math.max(budget, 0));
      if (looksBinary(buffer)) return { path: relative, binary: true, content: "" };
      budget -= buffer.length;
      return { path: relative, content: buffer.toString("utf8") };
    } catch {
      return { path: relative, omitted: "context budget exceeded; use read_files", content: "" };
    }
  });
}

/**
 * Design references are read from the base commit, so the candidate cannot
 * change what it is judged against.
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export function designReference(ctx) {
  let budget = DESIGN_BYTES;
  return ctx.task.design_reference.map((relative) => {
    const buffer = readBaseFile(ctx.candidate, relative, budget);
    if (buffer === null)
      throw new HarnessError(
        "config",
        "missing_design_reference",
        `design reference is missing at base: ${relative}`,
      );
    budget -= buffer.length;
    return {
      path: relative,
      content: looksBinary(buffer) ? "" : buffer.toString("utf8"),
      ...(looksBinary(buffer) ? { binary: true } : {}),
    };
  });
}

/** @param {import("../core/context.mjs").RunContext} ctx */
export function implementerBundle(ctx) {
  const checks = ctx.task.checks
    .filter((id) => !ctx.config.checks[id].unsandboxed)
    .map((id) => ({
      id,
      description: ctx.config.checks[id].description ?? null,
    }));
  return {
    task: { task_id: ctx.task.task_id, description: ctx.task.description },
    acceptance_criteria: ctx.task.acceptance_criteria,
    allowed_paths: ctx.task.allowed_paths,
    read_only_paths: ctx.task.read_only_paths,
    protected_paths: effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed),
    judge_inputs: ctx.config.paths.judge_inputs,
    declared_judge_input_changes: ctx.task.judge_input_changes,
    checks,
    fixers: ctx.task.fixers.map((id) => ({
      id,
      description: ctx.config.fixers[id].description ?? null,
      automatic: "runs before checks; you do not need to hand-format",
    })),
    attempt: ctx.state.attempt,
    findings: ctx.state.findings,
    verification_history: ctx.state.verification_history,
    previous_summary: ctx.state.implementation?.summary ?? null,
    initial_context: initialContext(ctx),
    design_reference: designReference(ctx),
    ...(ctx.integration ? { integration: { topic: ctx.integration.topic, onto: ctx.integration.onto } } : {}),
  };
}

/**
 * `agent` stage for the implementer role.
 * @param {import("../core/workflow.mjs").StageDefinition} stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runImplementStage(stage, ctx) {
  if (stage.role !== "implementer")
    throw new HarnessError("config", "invalid_workflow", "agent stages run the implementer role");
  const bundle = implementerBundle(ctx);
  const { result } = await invokeAgent(ctx, "implementer", bundle);
  ctx.state.implementation = {
    summary: result.summary,
    judge_input_changes: result.judge_input_changes ?? [],
    criteria_evidence: result.criteria_evidence ?? [],
    unresolved_uncertainties: result.unresolved_uncertainties ?? [],
  };
  ctx.state.attempt += 1;
  if (result.status === "blocked") {
    ctx.state.implementation.status = "blocked";
    ctx.state.implementation.blocked_reason = result.blocked_reason;
    ctx.event("implementer.blocked", { reason: result.blocked_reason });
    ctx.state.reason = `implementer reported blocked: ${result.blocked_reason}`.slice(0, 1000);
    return "blocked";
  }
  const snapshot = snapshotCandidate(ctx.candidate);
  ctx.event("candidate.snapshot", {
    candidate_digest: snapshot.candidate_digest,
    changed_files: snapshot.changed_files.length,
  });
  return snapshot.changed_files.length ? "done" : "no_changes";
}
