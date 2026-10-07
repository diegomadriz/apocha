// @ts-check

/**
 * @typedef {{
 *   path: string, change: "modified" | "deleted",
 *   declared: boolean, kind?: "behaviour" | "refactor" | "fixture", reason?: string,
 *   old_on_candidate?: "old_fails_on_candidate" | "old_passes_on_candidate" | "error",
 *   new_on_base?: "passes_on_base" | "fails_on_base" | "error" | "not_run",
 *   verdict: "necessary" | "unnecessary" | "weakened" | "error" | "refactor" | "declared_fixture",
 * }} TestChangeEvidence
 */

/**
 * The run context passed to every stage. `state` is the serializable part,
 * persisted to run.json after every transition so a paused run can resume.
 *
 * @typedef {{
 *   stage: string,
 *   reason: string | null,
 *   counters: Record<string, number>,
 *   invocations: number,
 *   retries: number,
 *   attempt: number,
 *   findings: { source: "review" | "verification", id: string, reason: string, path?: string, check_id?: string }[],
 *   verification_history: { attempt: number, failed_checks: string[], first_lines: Record<string, string[]> }[],
 *   last_verification: null | {
 *     status: string, candidate_digest: string, changed_files: string[], duration_ms?: number,
 *     effective_policy?: import("../config/task.mjs").Task["test_edits"], reason?: string,
 *     fixers?: import("../checks/fixers.mjs").FixerResult[],
 *     test_changes?: TestChangeEvidence[],
 *     tests_on_base?: { path: string, result: "passes_on_base" | "fails_on_base" | "error" | "not_run" }[],
 *     checks: { id: string, status: string, exit_code?: number | null, error?: string | null, definition_digest?: string, sandbox?: string, output_digest?: string, duration_ms?: number, files?: string[] }[],
 *   },
 *   last_review: null | { decision: string, findings: any[], reason?: string, candidate_digest: string },
 *   implementation: null | { summary: string, unresolved_uncertainties: string[], status?: "blocked", blocked_reason?: string },
 *   runtimes: { implementer?: any, reviewer?: any },
 *   usage: Record<string, Record<string, number>>,
 *   decisions: Record<string, "approve" | "reject">,
 *   awaiting: string | null,
 *   promotion: null | { old_head: string, promoted_head: string, tree: string, parents: string[] },
 *   seed: null | Record<string, unknown>,
 *   error: null | Record<string, unknown>,
 * }} RunState
 *
 * @typedef {{
 *   runId: string,
 *   store: import("./runs.mjs").RunStore,
 *   stateDir: string,
 *   repositoryRoot: string,
 *   workflow: import("./workflow.mjs").WorkflowDefinition,
 *   config: import("../config/project.mjs").ProjectConfig,
 *   runtimes: import("../config/runtime.mjs").RuntimeConfig,
 *   task: import("../config/task.mjs").Task,
 *   taskDigest: string,
 *   candidate: import("../git/candidate.mjs").Candidate,
 *   adapters: { implementer: import("../adapters/contract.mjs").Adapter, reviewer: import("../adapters/contract.mjs").Adapter },
 *   secretFileCache?: import("../checks/runner.mjs").SecretFileCache,
 *   sandboxBackend: import("../sandbox/index.mjs").SandboxBackend,
 *   batchRef: string,
 *   message: string,
 *   additionalParents: string[],
 *   governance: { edits_allowed: boolean, by: string | null, reason: string | null },
 *   integration: null | { topic: string, topic_commit: string, onto: string, onto_commit: string, checks: string[] | null },
 *   policyDigest: string,
 *   signal?: AbortSignal,
 *   state: RunState,
 *   event: (type: string, data?: Record<string, unknown>) => void,
 *   persist: () => void,
 * }} RunContext
 */

/** @returns {RunState} */
export function initialState(start) {
  return {
    stage: start,
    reason: null,
    counters: {},
    invocations: 0,
    retries: 0,
    attempt: 0,
    findings: [],
    verification_history: [],
    last_verification: null,
    last_review: null,
    implementation: null,
    runtimes: {},
    usage: {},
    decisions: {},
    awaiting: null,
    promotion: null,
    seed: null,
    error: null,
  };
}
