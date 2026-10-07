// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { adapterForRole } from "../adapters/index.mjs";
import { warnCatalogUnsandboxedChecks } from "../checks/sandbox.mjs";
import { loadProjectConfigAt, selectChecks } from "../config/project.mjs";
import { loadRuntimeConfig, roleProvider } from "../config/runtime.mjs";
import { taskDigest, validateTask } from "../config/task.mjs";
import { attachCandidate, createCandidate } from "../git/candidate.mjs";
import { assertBatchRef, reserveBatchRef } from "../git/promotion.mjs";
import { resolveBackend } from "../sandbox/index.mjs";
import { policyDigest } from "../stages/invoke.mjs";
import { describeError, HarnessError } from "../util/errors.mjs";
import {
  configuredIdentity,
  deleteRef,
  repositoryRoot as findRoot,
  git,
  resolveCommit,
} from "../util/git.mjs";
import { getWorkflow } from "../workflows/index.mjs";
import { initialState } from "./context.mjs";
import { runEngine } from "./engine.mjs";
import { withLock } from "./lock.mjs";
import { newRunId, RunStore, stateDir } from "./runs.mjs";

/**
 * Run lifecycle around the engine: resolve inputs, reserve the batch ref,
 * create the candidate, run the workflow, and finalize (report, ref release,
 * cleanup). Every run is recorded in the run store, whatever its outcome.
 */

/**
 * @typedef {{
 *   cwd: string,
 *   workflow?: "code-delivery" | "integrate",
 *   task?: unknown,
 *   base: string,
 *   batch: string,
 *   message: string,
 *   runtimesPath?: string,
 *   trustRepoRuntimes?: boolean,
 *   runtimes?: import("../config/runtime.mjs").RuntimeConfig,
 *   adapters?: { implementer: import("../adapters/contract.mjs").Adapter, reviewer: import("../adapters/contract.mjs").Adapter },
 *   allowGovernanceEdits?: boolean,
 *   governanceReason?: string,
 *   integration?: { topic: string, checks?: string[] | null, maxRepairs?: number, testEdits?: import("../config/task.mjs").Task["test_edits"] },
 *   signal?: AbortSignal,
 *   onEvent?: (event: Record<string, unknown>) => void,
 * }} StartOptions
 */

/** @param {StartOptions} options */
export async function startRun(options) {
  const repositoryRoot = findRoot(options.cwd);
  const workflow = getWorkflow(options.workflow ?? "code-delivery");
  const baseCommit = resolveCommit(repositoryRoot, options.base);
  if (!baseCommit)
    throw new HarnessError("config", "unknown_base", `base does not resolve to a commit: ${options.base}`);
  const config = loadProjectConfigAt(repositoryRoot, baseCommit);
  const runtimes =
    options.runtimes ?? loadRuntimeConfig(repositoryRoot, options.runtimesPath, options.trustRepoRuntimes);
  assertReviewIndependence(config, runtimes);
  if (typeof options.message !== "string" || !options.message.trim())
    throw new HarnessError("config", "invalid_message", "a commit message is required");

  /** @type {import("./context.mjs").RunContext["integration"]} */
  let integration = null;
  let task;
  const additionalParents = [];
  if (workflow.id === "integrate") {
    if (!options.integration) throw new HarnessError("config", "missing_topic", "integrate needs a topic");
    const topicCommit = resolveCommit(repositoryRoot, options.integration.topic);
    if (!topicCommit)
      throw new HarnessError(
        "config",
        "unknown_topic",
        `topic does not resolve to a commit: ${options.integration.topic}`,
      );
    const ancestor = git(repositoryRoot, ["merge-base", "--is-ancestor", topicCommit, baseCommit], {
      allowFailure: true,
    });
    if (ancestor.status === 0)
      throw new HarnessError("config", "nothing_to_integrate", "the topic is already contained in the base");
    for (const id of options.integration.checks ?? []) {
      if (!Object.hasOwn(config.checks, id))
        throw new HarnessError("config", "unknown_check", `unknown check ID: ${id}`);
    }
    integration = {
      topic: options.integration.topic,
      topic_commit: topicCommit,
      onto: options.base,
      onto_commit: baseCommit,
      checks: options.integration.checks ?? null,
      testEdits: options.integration.testEdits,
    };
    additionalParents.push(topicCommit);
    const subjects = String(
      git(repositoryRoot, ["log", "--format=%s", "-n", "20", `${baseCommit}..${topicCommit}`]).stdout,
    ).trim();
    // Placeholder task; the merge stage replaces scope and checks with what the merge changed.
    task = validateTask(
      {
        task_id: options.batch.split("/").at(-1),
        description:
          `Integrate ${options.integration.topic} (${topicCommit.slice(0, 12)}) into ${options.base} (${baseCommit.slice(0, 12)}). Topic commits:\n${subjects}`.slice(
            0,
            8000,
          ),
        acceptance_criteria: [
          "The merged tree passes its checks and the combined change is coherent with the base.",
        ],
        allowed_paths: [".apocha-integration-pending"],
        checks: [],
        max_repair_attempts: options.integration.maxRepairs ?? config.limits.default_repair_attempts,
        test_edits: options.integration.testEdits ?? "additive",
      },
      config,
    );
  } else {
    task = validateTask(options.task, config, baseCommit);
    if (!task.checks.length) {
      throw new HarnessError(
        "config",
        "no_checks",
        "the task selects no checks; name checks in the task or add check_selection rules",
      );
    }
  }

  const batchRef = `${config.refs.batch_prefix}${options.batch}`;
  assertBatchRef(repositoryRoot, batchRef, config.refs.batch_prefix);
  let governance = { edits_allowed: false, by: null, reason: null };
  if (options.allowGovernanceEdits) {
    if (!options.governanceReason?.trim())
      throw new HarnessError("config", "governance_reason", "--allow-governance-edits needs --reason");
    const identity = configuredIdentity(repositoryRoot);
    governance = {
      edits_allowed: true,
      by: `${identity.name} <${identity.email}>`,
      reason: options.governanceReason.trim().slice(0, 1000),
    };
  }
  const selectedChecks = integration
    ? (integration.checks ??
      selectChecks(
        config,
        String(
          git(repositoryRoot, ["diff", "--name-only", "-z", baseCommit, integration.topic_commit]).stdout,
        )
          .split("\0")
          .filter(Boolean),
      ))
    : task.checks;
  const unsandboxed = selectedChecks.filter((id) => config.checks[id].unsandboxed);
  if (unsandboxed.length && !governance.edits_allowed)
    throw new HarnessError(
      "config",
      "unsandboxed_approval",
      `unsandboxed checks ${unsandboxed.join(", ")} require --allow-governance-edits with a non-empty --reason`,
    );
  // Integration selects its checks after merging; runCheck enforces required mode then.
  const needsSandbox =
    !integration &&
    (task.checks.some((id) => !config.checks[id].unsandboxed) ||
      (task.fixers ?? config.default_fixers).length > 0);
  const sandboxBackend = resolveBackend(
    config.sandbox.mode === "required" && !needsSandbox ? "auto" : config.sandbox.mode,
  );
  const adapters = options.adapters ?? {
    implementer: adapterForRole(runtimes, "implementer"),
    reviewer: adapterForRole(runtimes, "reviewer"),
  };

  const store = new RunStore(repositoryRoot);
  // A run must not build on another run's batch while that run can still change it.
  const fullBase = String(
    git(repositoryRoot, ["rev-parse", "--symbolic-full-name", options.base], { allowFailure: true }).stdout ??
      "",
  ).trim();
  const unfinished = fullBase
    ? store.activeRunsNaming(fullBase).filter((run) => run.batch_ref === fullBase)
    : [];
  if (unfinished.length) {
    throw new HarnessError(
      "config",
      "base_in_flight",
      `base ${options.base} is the batch of run ${unfinished[0].run_id}, which has not finished`,
    );
  }
  const runId = newRunId(task.task_id);
  const dir = stateDir(repositoryRoot);
  const digest = taskDigest(task);
  await withLock(dir, `reserve ${batchRef}`, () => reserveBatchRef(repositoryRoot, batchRef, baseCommit));
  let created = false;
  let candidate;
  let paused = false;
  try {
    store.create(runId, {
      workflow: workflow.id,
      task_id: task.task_id,
      task,
      task_digest: digest,
      base_ref: options.base,
      base_commit: baseCommit,
      batch_ref: batchRef,
      message: options.message,
      additional_parents: additionalParents,
      integration,
      governance,
      config_digest: config.digest,
      runtime_config_source: runtimes.source,
      runtime_config_digest: runtimes.digest,
      runtime_config_digests: [runtimes.digest],
      roles: runtimes.roles,
      sandbox: sandboxBackend,
      pid: process.pid,
    });

    created = true;
    candidate = createCandidate(repositoryRoot, baseCommit, { runId });
    store.update(runId, { candidate_root: candidate.root });

    const ctx = buildContext({
      runId,
      store,
      dir,
      repositoryRoot,
      workflow,
      config,
      runtimes,
      task,
      taskDigest: digest,
      candidate,
      adapters,
      sandboxBackend,
      batchRef,
      message: options.message,
      additionalParents,
      governance,
      integration,
      signal: options.signal,
      onEvent: options.onEvent,
      state: initialState(workflow.start),
    });
    ctx.event("run.started", {
      workflow: workflow.id,
      task_id: task.task_id,
      base_commit: baseCommit,
      batch_ref: batchRef,
      sandbox: sandboxBackend,
    });
    warnUnsandboxedChecks(ctx);
    const summary = finish(ctx, await runEngine(ctx));
    paused = summary.outcome === "PAUSED";
    return summary;
  } catch (error) {
    const detail = describeError(error);
    if (created) {
      store.update(runId, {
        outcome: "ERROR",
        reason: detail.message,
        error_class: detail.error_class,
        code: detail.code,
        finished_at: new Date().toISOString(),
      });
    }
    deleteRef(repositoryRoot, batchRef, baseCommit);
    throw error;
  } finally {
    if (!paused) candidate?.cleanup();
  }
}

/**
 * Resume a PAUSED run from the stage it paused in.
 * @param {{ cwd: string, runId: string, decision?: "approve" | "reject", runtimesPath?: string, trustRepoRuntimes?: boolean, runtimes?: import("../config/runtime.mjs").RuntimeConfig, adapters?: StartOptions["adapters"], signal?: AbortSignal, onEvent?: StartOptions["onEvent"] }} options
 */
export async function resumeRun(options) {
  const repositoryRoot = findRoot(options.cwd);
  const store = new RunStore(repositoryRoot);
  const record = store.read(options.runId);
  if (record.outcome !== "PAUSED")
    throw new HarnessError("config", "not_paused", `run ${options.runId} is ${record.outcome}, not PAUSED`);
  if (!record.candidate_root || !existsSync(path.join(record.candidate_root, ".git"))) {
    throw new HarnessError(
      "infra",
      "candidate_gone",
      "the paused candidate directory no longer exists; start a new run",
    );
  }
  const workflow = getWorkflow(record.workflow);
  const config = loadProjectConfigAt(repositoryRoot, record.base_commit);
  const runtimes =
    options.runtimes ?? loadRuntimeConfig(repositoryRoot, options.runtimesPath, options.trustRepoRuntimes);
  assertReviewIndependence(config, runtimes);
  const state = record.state;
  if (state.awaiting) {
    if (!options.decision)
      throw new HarnessError(
        "config",
        "decision_required",
        `run is waiting for a decision at ${state.awaiting}: pass --decision approve|reject`,
      );
    state.decisions[state.awaiting] = options.decision;
    state.awaiting = null;
  }
  state.error = null;
  state.reason = null;
  const ctx = buildContext({
    runId: options.runId,
    store,
    dir: stateDir(repositoryRoot),
    repositoryRoot,
    workflow,
    config,
    runtimes,
    task: record.task,
    taskDigest: record.task_digest,
    candidate: attachCandidate(repositoryRoot, record.candidate_root, record.base_commit),
    adapters: options.adapters ?? {
      implementer: adapterForRole(runtimes, "implementer"),
      reviewer: adapterForRole(runtimes, "reviewer"),
    },
    sandboxBackend: record.sandbox,
    batchRef: record.batch_ref,
    message: record.message,
    additionalParents: record.additional_parents ?? [],
    governance: record.governance,
    integration: record.integration ?? null,
    signal: options.signal,
    onEvent: options.onEvent,
    state,
  });
  let paused = false;
  try {
    const runtimeConfigDigests = record.runtime_config_digests ?? [record.runtime_config_digest];
    // Recover the last known resume config from records written before history was stored.
    if (
      !record.runtime_config_digests &&
      record.runtime_config_digest_on_resume &&
      runtimeConfigDigests.at(-1) !== record.runtime_config_digest_on_resume
    )
      runtimeConfigDigests.push(record.runtime_config_digest_on_resume);
    if (runtimeConfigDigests.at(-1) !== runtimes.digest) runtimeConfigDigests.push(runtimes.digest);
    store.update(options.runId, {
      outcome: "RUNNING",
      pid: process.pid,
      runtime_config_digest_on_resume: runtimes.digest,
      runtime_config_digests: runtimeConfigDigests,
    });
    ctx.event("run.resumed", {
      stage: state.stage,
      ...(options.decision ? { decision: options.decision } : {}),
    });
    warnUnsandboxedChecks(ctx);
    const summary = finish(ctx, await runEngine(ctx));
    paused = summary.outcome === "PAUSED";
    return summary;
  } catch (error) {
    const detail = describeError(error);
    store.update(options.runId, {
      outcome: "ERROR",
      reason: detail.message,
      error_class: detail.error_class,
      code: detail.code,
      finished_at: new Date().toISOString(),
    });
    deleteRef(repositoryRoot, record.batch_ref, record.base_commit);
    throw error;
  } finally {
    if (!paused) ctx.candidate.cleanup();
  }
}

/**
 * @param {import("../config/project.mjs").ProjectConfig} config
 * @param {import("../config/runtime.mjs").RuntimeConfig} runtimes
 */
function assertReviewIndependence(config, runtimes) {
  const implementer = roleProvider(
    runtimes.roles.implementer,
    runtimes.adapters[runtimes.roles.implementer.adapter],
  );
  const reviewer = roleProvider(runtimes.roles.reviewer, runtimes.adapters[runtimes.roles.reviewer.adapter]);
  if (config.review.require_independent && implementer === reviewer) {
    throw new HarnessError(
      "config",
      "reviewer_not_independent",
      `independent review required: implementer provider=${implementer}, reviewer provider=${reviewer}`,
    );
  }
}

/** @param {import("./context.mjs").RunContext} ctx */
function warnUnsandboxedChecks(ctx) {
  warnCatalogUnsandboxedChecks(ctx);
  if (ctx.config.sandbox.mode === "auto" && ctx.sandboxBackend === "none") {
    ctx.event("sandbox.warning", {
      reason: "sandbox_unavailable",
      message:
        "checks will execute without an OS sandbox because no sandbox backend is available; set sandbox.mode to required to refuse unsandboxed checks",
    });
  }
}

/** @param {Record<string, any>} input @returns {import("./context.mjs").RunContext} */
function buildContext(input) {
  /** @type {import("./context.mjs").RunContext} */
  const ctx = {
    runId: input.runId,
    store: input.store,
    stateDir: input.dir,
    repositoryRoot: input.repositoryRoot,
    workflow: input.workflow,
    config: input.config,
    runtimes: input.runtimes,
    task: input.task,
    taskDigest: input.taskDigest,
    candidate: input.candidate,
    adapters: input.adapters,
    sandboxBackend: input.sandboxBackend,
    batchRef: input.batchRef,
    message: input.message,
    additionalParents: input.additionalParents,
    governance: input.governance,
    integration: input.integration,
    policyDigest: policyDigest(input.workflow),
    signal: input.signal,
    state: input.state,
    event(type, data = {}) {
      input.store.event(input.runId, type, data);
      input.onEvent?.({ type, ...data });
    },
    persist() {
      input.store.update(input.runId, { state: ctx.state, task: ctx.task, task_digest: ctx.taskDigest });
    },
  };
  return ctx;
}

/**
 * @param {import("./context.mjs").RunContext} ctx
 * @param {{ outcome: string, reason: string | null }} result
 */
function finish(ctx, result) {
  const paused = result.outcome === "PAUSED";
  if (!paused && result.outcome !== "PASSED")
    deleteRef(ctx.repositoryRoot, ctx.batchRef, ctx.candidate.base_commit);
  const summary = {
    run_id: ctx.runId,
    workflow: ctx.workflow.id,
    task_id: ctx.task.task_id,
    outcome: result.outcome,
    reason: result.reason,
    error_class: ctx.state.error?.error_class ?? null,
    code: ctx.state.error?.code ?? null,
    base_commit: ctx.candidate.base_commit,
    batch_ref: ctx.batchRef,
    promoted_head: ctx.state.promotion?.promoted_head ?? null,
    candidate_digest: ctx.state.last_verification?.candidate_digest ?? null,
    repairs: ctx.state.counters.repairs ?? 0,
    agent_invocations: ctx.state.invocations,
    retries: ctx.state.retries,
    checks: ctx.state.last_verification?.checks.map(({ id, status }) => ({ id, status })) ?? [],
    review: ctx.state.last_review
      ? { decision: ctx.state.last_review.decision, findings: ctx.state.last_review.findings }
      : null,
    runtimes: ctx.state.runtimes,
    usage: ctx.state.usage,
  };
  ctx.store.writeReport(ctx.runId, { ...summary, state: ctx.state });
  ctx.store.update(ctx.runId, {
    outcome: result.outcome,
    reason: result.reason,
    error_class: summary.error_class,
    code: summary.code,
    repairs: summary.repairs,
    agent_invocations: summary.agent_invocations,
    retries: summary.retries,
    promoted_head: summary.promoted_head,
    state: ctx.state,
    ...(paused ? {} : { finished_at: new Date().toISOString() }),
  });
  ctx.event("run.finished", { outcome: result.outcome, reason: result.reason });
  return summary;
}
