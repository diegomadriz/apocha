// @ts-check
import { fileURLToPath } from "node:url";
import { HarnessError } from "../../util/errors.mjs";
import { MCP_SERVER_NAME } from "../mcp-names.mjs";
import {
  classifyProviderMessage,
  cliVersion,
  compareVersions,
  runJsonlProcess,
  runtimeEnvironment,
} from "../process.mjs";

/**
 * Codex CLI adapter (`codex exec`). Runs on the user's ChatGPT sign-in or API key.
 *
 * Lock-down, three layers:
 * 1. every built-in capability that could act outside the harness is disabled
 *    (shell, exec, app connectors, plugins, browser, computer use, web search,
 *    sub-agents, memories, hooks, project docs);
 * 2. the OS sandbox is read-only with approvals off, so anything left cannot
 *    write or execute;
 * 3. the event stream is checked: any command, file change, web search,
 *    collaboration item, or call to another MCP server ends the run with
 *    `policy_violation`.
 *
 * Code mode (`code_mode_host`) must stay enabled: Codex routes tool calls
 * through it. It has no filesystem access.
 */

export const DISABLED_FEATURES = Object.freeze([
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "image_generation",
  "memories",
  "multi_agent",
  "skill_search",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "tool_suggest",
  "view_image",
  "hooks",
  "workspace_dependencies",
  "worktrees",
  "in_app_browser",
  "in_app_chat",
  "in_app_local_automation",
  "realtime_conversation",
]);

const MCP_ENTRY = fileURLToPath(new URL("../mcp-server-main.mjs", import.meta.url));
const ALLOWED_INTERNAL_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
const FORBIDDEN_ITEMS = new Set([
  "command_execution",
  "file_change",
  "web_search",
  "collab_tool_call",
  "image_generation",
]);

/** @param {string} value */
const toml = (value) => JSON.stringify(value);

/**
 * @param {import("../contract.mjs").Invocation} invocation
 * @param {string} command
 */
export function codexArgs(invocation, command) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
  ];
  for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
  args.push(
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.command=${toml(process.execPath)}`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.args=[${toml(MCP_ENTRY)}]`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.env={ APOCHA_SESSION = ${toml(invocation.sessionFile)} }`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.required=true`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=1800`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.startup_timeout_sec=30`,
  );
  if (invocation.model) args.push("-m", invocation.model);
  if (invocation.effort)
    args.push(
      "-c",
      `model_reasoning_effort=${toml(invocation.effort === "off" ? "minimal" : invocation.effort)}`,
    );
  args.push("-");
  void command;
  return args;
}

/**
 * Inspect one `codex exec --json` event. Returns usage/error info, or throws on a policy violation.
 * @param {any} event
 * @param {{ usage: any, errors: string[], final_message?: string }} state
 */
export function inspectCodexEvent(event, state) {
  if (event.type === "turn.completed" && event.usage) state.usage = event.usage;
  if (event.type === "turn.failed") state.errors.push(String(event.error?.message ?? "turn failed"));
  if (event.type === "error") state.errors.push(String(event.message ?? "error"));
  const item = event.item;
  if (!item || (event.type !== "item.started" && event.type !== "item.completed")) return;
  if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string")
    state.final_message = item.text.slice(0, 2000);
  if (FORBIDDEN_ITEMS.has(item.type)) {
    throw new HarnessError(
      "policy_violation",
      "codex_capability",
      `codex used a disallowed capability: ${item.type}`,
    );
  }
  if (item.type === "mcp_tool_call") {
    const internal = item.server === "codex" && ALLOWED_INTERNAL_TOOLS.has(item.tool);
    if (item.server !== MCP_SERVER_NAME && !internal) {
      throw new HarnessError(
        "policy_violation",
        "codex_foreign_tool",
        `codex called a tool outside the harness: ${item.server}/${item.tool}`,
      );
    }
  }
  if (
    event.type === "item.completed" &&
    item.type === "error" &&
    typeof item.message === "string" &&
    !/ignoring \d+ unrecognized/i.test(item.message)
  ) {
    state.errors.push(item.message);
  }
}

/** @param {import("../../config/runtime.mjs").AdapterSettings} [settings] */
export function createCodexAdapter(settings = {}) {
  const command = settings.command ?? "codex";
  return {
    name: "codex",
    probe() {
      const version = cliVersion(command);
      const problems = [];
      if (!version) problems.push(`${command} not found or --version failed`);
      else if (settings.min_version && compareVersions(version, settings.min_version) < 0)
        problems.push(`codex ${version} is older than ${settings.min_version}`);
      return { adapter: "codex", command, version, ok: problems.length === 0, problems };
    },
    /** @param {import("../contract.mjs").Invocation} invocation */
    async run(invocation) {
      const version = cliVersion(command);
      if (!version) throw new HarnessError("infra", "runtime_missing", `${command} is not available`);
      /** @type {{ usage: any, errors: string[], final_message?: string }} */
      const state = { usage: null, errors: [] };
      const exit = await runJsonlProcess({
        command,
        args: codexArgs(invocation, command),
        cwd: invocation.cwd,
        env: runtimeEnvironment(),
        input: `${invocation.systemPrompt}\n\n${invocation.taskPrompt}`,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        onEvent: (event) => inspectCodexEvent(event, state),
      });
      const runtime = {
        adapter: "codex",
        adapter_version: version,
        provider: "openai",
        model: invocation.model ?? null,
      };
      if (state.errors.length || exit.code !== 0) {
        const message =
          state.errors.join(" | ") || exit.stderrTail || `codex exited with ${exit.code ?? exit.signal}`;
        const { errorClass, retryAfter } = classifyProviderMessage(message);
        if (state.errors.length || errorClass === "usage_limited") {
          throw new HarnessError(errorClass, "codex_error", message.slice(0, 500), {
            retryAfter,
            details: { runtime },
          });
        }
        throw new HarnessError("infra", "codex_exit", message.slice(0, 500), { details: { runtime } });
      }
      return {
        runtime,
        usage: normalizeCodexUsage(state.usage),
        ...(state.final_message !== undefined ? { final_message: state.final_message } : {}),
      };
    },
  };
}

/** @param {any} usage */
function normalizeCodexUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens ?? 0,
    cached_input_tokens: usage.cached_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    reasoning_tokens: usage.reasoning_output_tokens ?? 0,
  };
}
