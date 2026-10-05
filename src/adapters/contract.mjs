// @ts-check

/**
 * The adapter contract. An adapter starts an agent runtime for one role, gives
 * it the harness tools, and waits for it to finish. It does not return the
 * agent's result: the result and the tool trace are written by the harness
 * tool server into the session directory, and the controller reads them from
 * there. That keeps one result format across every runtime.
 *
 * @typedef {{
 *   role: "implementer" | "reviewer",
 *   model?: string,
 *   provider?: string,
 *   effort?: string,
 *   systemPrompt: string,
 *   taskPrompt: string,
 *   bundle: Record<string, unknown>,
 *   sessionDir: string,
 *   sessionFile: string,
 *   cwd: string,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 * }} Invocation
 *
 * @typedef {{ adapter: string, adapter_version: string | null, provider: string | null, model: string | null }} RuntimeIdentity
 *
 * @typedef {{ runtime: RuntimeIdentity, usage: Record<string, number | null> | null }} AgentRun
 *
 * @typedef {{ adapter: string, command?: string, version: string | null, ok: boolean, problems: string[] }} Probe
 *
 * @typedef {{
 *   name: string,
 *   probe: () => Probe | Promise<Probe>,
 *   run: (invocation: Invocation) => Promise<AgentRun>,
 * }} Adapter
 *
 * Errors: adapters throw HarnessError with class `infra`, `provider`,
 * `usage_limited`, `agent`, `tool_protocol`, or `policy_violation`.
 */

export {};
