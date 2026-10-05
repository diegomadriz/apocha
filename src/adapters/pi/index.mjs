// @ts-check
import { fileURLToPath } from "node:url";
import { toolDefinitions } from "../../tools/definitions.mjs";
import { HarnessError } from "../../util/errors.mjs";
import {
  classifyProviderMessage,
  cliVersion,
  compareVersions,
  runJsonlProcess,
  runtimeEnvironment,
} from "../process.mjs";

/**
 * Pi adapter (`pi --mode json --print`). Tools are registered in-process by a
 * Pi extension; every built-in tool, extension, skill, prompt template, theme,
 * and context file is disabled, and project-local files are ignored.
 *
 * Note: Pi's `openai-codex` provider reaches a ChatGPT subscription through an
 * unofficial path. Prefer the `codex` adapter for subscription use.
 */

const EXTENSION = fileURLToPath(new URL("./extension.mjs", import.meta.url));
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * @param {import("../contract.mjs").Invocation} invocation
 * @param {string | undefined} provider
 */
export function piArgs(invocation, provider) {
  const names = toolDefinitions(invocation.role).map((tool) => tool.name);
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--tools",
    names.join(","),
    "--extension",
    EXTENSION,
    "--system-prompt",
    invocation.systemPrompt,
  ];
  if (provider) args.push("--provider", provider);
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort && THINKING.has(invocation.effort)) args.push("--thinking", invocation.effort);
  return args;
}

/**
 * @param {any} event
 * @param {{ allowed: Set<string>, usage: any, model: string | null, provider: string | null, providerError: string | null }} state
 */
export function inspectPiEvent(event, state) {
  if (event.type === "tool_execution_start" && !state.allowed.has(event.toolName)) {
    throw new HarnessError(
      "policy_violation",
      "pi_foreign_tool",
      `pi called a tool outside the harness: ${event.toolName}`,
    );
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const message = event.message;
    if (message.stopReason === "error")
      state.providerError = String(message.errorMessage ?? "provider error");
    if (typeof message.model === "string") state.model = message.model;
    if (typeof message.provider === "string") state.provider = message.provider;
    const usage = message.usage;
    if (usage && typeof usage.input === "number") {
      const total = state.usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      total.input_tokens += usage.input ?? 0;
      total.cached_input_tokens += usage.cacheRead ?? 0;
      total.output_tokens += usage.output ?? 0;
      total.cost_usd += usage.cost?.total ?? 0;
      state.usage = total;
    }
  }
}

/** @param {import("../../config/runtime.mjs").AdapterSettings} [settings] */
export function createPiAdapter(settings = {}) {
  const command = settings.command ?? "pi";
  return {
    name: "pi",
    probe() {
      const version = cliVersion(command);
      const problems = [];
      if (!version) problems.push(`${command} not found or --version failed`);
      else if (settings.min_version && compareVersions(version, settings.min_version) < 0)
        problems.push(`pi ${version} is older than ${settings.min_version}`);
      return { adapter: "pi", command, version, ok: problems.length === 0, problems };
    },
    /** @param {import("../contract.mjs").Invocation} invocation */
    async run(invocation) {
      const version = cliVersion(command);
      if (!version) throw new HarnessError("infra", "runtime_missing", `${command} is not available`);
      const provider = invocation.provider ?? settings.provider;
      const state = {
        allowed: new Set(toolDefinitions(invocation.role).map((tool) => tool.name)),
        usage: null,
        model: null,
        provider: null,
        providerError: null,
      };
      const exit = await runJsonlProcess({
        command,
        args: piArgs(invocation, provider),
        cwd: invocation.cwd,
        env: runtimeEnvironment({ APOCHA_SESSION: invocation.sessionFile }),
        input: invocation.taskPrompt,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        onEvent: (event) => inspectPiEvent(event, state),
      });
      const runtime = {
        adapter: "pi",
        adapter_version: version,
        provider: state.provider ?? provider ?? null,
        model: state.model ?? invocation.model ?? null,
      };
      if (state.providerError) {
        const { errorClass, retryAfter } = classifyProviderMessage(state.providerError);
        throw new HarnessError(errorClass, "pi_provider_error", state.providerError.slice(0, 500), {
          retryAfter,
          details: { runtime },
        });
      }
      if (exit.code !== 0) {
        throw new HarnessError(
          "infra",
          "pi_exit",
          (exit.stderrTail || `pi exited with ${exit.code ?? exit.signal}`).slice(0, 500),
          { details: { runtime } },
        );
      }
      return { runtime, usage: state.usage };
    },
  };
}
