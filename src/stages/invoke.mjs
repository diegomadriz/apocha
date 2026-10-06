// @ts-check
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveProtectedPaths } from "../config/task.mjs";
import { existingTestFiles } from "../git/test-edits.mjs";
import { toolDefinitions } from "../tools/definitions.mjs";
import { readSession, TOOL_LIMITS } from "../tools/project-tools.mjs";
import { digestJson } from "../util/digest.mjs";
import { describeError, HarnessError } from "../util/errors.mjs";
import { writeJsonAtomic } from "../util/fs-safe.mjs";
import { gitCommonDir } from "../util/git.mjs";
import { makeTempDir, removeTempDir } from "../util/temp.mjs";
import { GENERATOR } from "../version.mjs";

/** @param {"implementer" | "reviewer"} role */
export function rolePrompt(role) {
  return readFileSync(new URL(`../prompts/${role}.md`, import.meta.url), "utf8");
}

/**
 * Digest of everything that shapes agent behavior on the harness side:
 * prompts, tool definitions and limits, the workflow, and the package version.
 * Recorded in receipts so results can be compared across harness versions.
 * @param {import("../core/workflow.mjs").WorkflowDefinition} workflow
 */
export function policyDigest(workflow) {
  return digestJson({
    generator: GENERATOR,
    prompts: { implementer: rolePrompt("implementer"), reviewer: rolePrompt("reviewer") },
    tools: { implementer: toolDefinitions("implementer"), reviewer: toolDefinitions("reviewer") },
    limits: TOOL_LIMITS,
    workflow,
  });
}

/** Error classes worth one more attempt: transient by nature. */
const RETRYABLE = new Set(["infra", "tool_protocol", "provider"]);

/**
 * Run one agent role through its adapter, with the harness retry policy.
 * Returns the submitted result and the tool trace from the session directory.
 *
 * @param {import("../core/context.mjs").RunContext} ctx
 * @param {"implementer" | "reviewer"} role
 * @param {Record<string, unknown>} bundle
 * @param {{ deletedPaths?: string[] }} [options]
 */
export async function invokeAgent(ctx, role, bundle, options = {}) {
  const adapter = ctx.adapters[role];
  const roleConfig = ctx.runtimes.roles[role];
  const maxAttempts = 1 + ctx.runtimes.retry.infra;
  for (let attempt = 1; ; attempt += 1) {
    if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
    ctx.state.invocations += 1;
    const index = ctx.state.invocations;
    const sessionDir = ctx.store.sessionDir(ctx.runId, index);
    const sessionFile = path.join(sessionDir, "session.json");
    /** @type {import("../tools/project-tools.mjs").SessionConfig} */
    const session = {
      version: 1,
      role,
      root: ctx.candidate.root,
      repository_root: ctx.candidate.repository_root,
      base_commit: ctx.candidate.base_commit,
      allowed_paths: role === "implementer" ? ctx.task.allowed_paths : [],
      read_only_paths: ctx.task.read_only_paths,
      protected_paths: effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed),
      forbidden_paths: ctx.config.paths.forbidden,
      deleted_paths: options.deletedPaths ?? [],
      test_edits: ctx.task.test_edits,
      existing_test_files: existingTestFiles(ctx.candidate, ctx.config),
      run_checks: role === "implementer" ? ctx.task.checks : [],
      max_tool_calls: ctx.runtimes.budgets.max_tool_calls,
      max_run_check_calls: ctx.config.limits.run_check_calls,
      sandbox_backend: ctx.sandboxBackend,
      project: ctx.config,
      session_dir: sessionDir,
    };
    writeJsonAtomic(sessionFile, session);
    const cwd = makeTempDir("agent", {
      runId: ctx.runId,
      repository: gitCommonDir(ctx.repositoryRoot),
    });
    const started = Date.now();
    /** @type {any} */
    let run = null;
    /** @type {unknown} */
    let failure = null;
    try {
      ctx.event("agent.started", {
        role,
        invocation: index,
        runtime_config_digest: ctx.runtimes.digest,
        adapter: adapter.name,
        model: roleConfig.model ?? null,
      });
      run = await adapter.run({
        role,
        model: roleConfig.model,
        provider: roleConfig.provider,
        effort: roleConfig.effort,
        systemPrompt: rolePrompt(role),
        taskPrompt: renderBundle(role, bundle),
        bundle,
        sessionDir,
        sessionFile,
        cwd,
        timeoutMs: ctx.runtimes.budgets.timeout_ms,
        signal: ctx.signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      removeTempDir(cwd);
    }
    const { trace, result } = readSession(sessionDir);
    const runtime = run?.runtime ?? /** @type {any} */ (failure)?.details?.runtime ?? null;
    if (runtime) ctx.state.runtimes[role] = runtime;
    if (run?.usage) addUsage(ctx.state.usage, role, run.usage);
    const summary = {
      role,
      invocation: index,
      runtime_config_digest: ctx.runtimes.digest,
      duration_ms: Date.now() - started,
      tool_calls: trace.length,
      tool_errors: trace.filter((entry) => !entry.ok).length,
      submitted: result !== null,
      ...(failure ? { error: describeError(failure) } : {}),
    };
    ctx.event("agent.finished", summary);

    if (ctx.signal?.aborted || (failure instanceof HarnessError && failure.code === "aborted"))
      throw new HarnessError("infra", "aborted", "run aborted");
    if (failure) {
      const errorClass = failure instanceof HarnessError ? failure.errorClass : "infra";
      // A runtime that crashed after the agent already submitted a valid result still counts.
      if (result && errorClass !== "policy_violation") return { result, trace, runtime };
      if (RETRYABLE.has(errorClass) && attempt < maxAttempts) {
        ctx.state.retries += 1;
        ctx.event("agent.retry", { role, invocation: index, reason: describeError(failure) });
        continue;
      }
      throw failure;
    }
    if (!result) {
      // No tool calls and no result usually means the runtime failed before the agent started. Retry once.
      if (trace.length === 0 && attempt < maxAttempts) {
        ctx.state.retries += 1;
        ctx.event("agent.retry", {
          role,
          invocation: index,
          reason: { error_class: "agent", code: "no_result_no_tools" },
        });
        continue;
      }
      throw new HarnessError(
        "agent",
        "no_result",
        `${role} finished without calling submit_result (${trace.length} tool calls)`,
      );
    }
    return { result, trace, runtime };
  }
}

/**
 * @param {Record<string, any>} usage
 * @param {string} role
 * @param {Record<string, number | null>} delta
 */
function addUsage(usage, role, delta) {
  const into = (usage[role] ??= {});
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === "number") into[key] = (into[key] ?? 0) + value;
  }
}

/**
 * The task prompt: a short framing line and the JSON bundle.
 * @param {"implementer" | "reviewer"} role
 * @param {Record<string, unknown>} bundle
 */
export function renderBundle(role, bundle) {
  const lead =
    role === "implementer"
      ? "Complete the task described in this bundle using the harness tools, then call submit_result."
      : "Review the candidate described in this bundle using the harness tools, then call submit_result.";
  return `${lead}\n\n\`\`\`json\n${JSON.stringify(bundle, null, 1)}\n\`\`\`\n`;
}
