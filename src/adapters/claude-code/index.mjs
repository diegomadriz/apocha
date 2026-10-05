// @ts-check
import { writeFileSync } from "node:fs";
import path from "node:path";
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
 * Claude Code adapter (`claude -p`). Runs on the user's Claude sign-in or API key.
 *
 * Lock-down:
 * - `--tools ""` removes every built-in tool; the only tools are the harness
 *   MCP server's (`--mcp-config` + `--strict-mcp-config`);
 * - `--setting-sources ""`, `--disable-slash-commands`, no session persistence,
 *   and an empty working directory, so no project settings, hooks, skills, or
 *   CLAUDE.md from the repository are loaded;
 * - permission mode `dontAsk` with only `mcp__panagent__*` allowed;
 * - the `init` event's tool list is checked before any work, and every
 *   assistant tool call is checked against the harness namespace.
 */

const MCP_ENTRY = fileURLToPath(new URL("../mcp-server-main.mjs", import.meta.url));
const PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * @param {import("../contract.mjs").Invocation} invocation
 * @param {string} mcpConfigFile
 */
export function claudeArgs(invocation, mcpConfigFile) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools",
    "",
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    `${PREFIX}*`,
    "--system-prompt",
    invocation.systemPrompt,
  ];
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort && invocation.effort !== "off" && invocation.effort !== "minimal")
    args.push("--effort", invocation.effort);
  return args;
}

/**
 * @param {any} event
 * @param {{ usage: any, model: string | null, result: any, toolsChecked: boolean }} state
 */
export function inspectClaudeEvent(event, state) {
  if (event.type === "system" && event.subtype === "init") {
    const foreign = (event.tools ?? []).filter((name) => !String(name).startsWith(PREFIX));
    if (foreign.length) {
      throw new HarnessError(
        "policy_violation",
        "claude_tools",
        `claude exposes tools outside the harness: ${foreign.slice(0, 10).join(", ")}`,
      );
    }
    const server = (event.mcp_servers ?? []).find((entry) => entry.name === MCP_SERVER_NAME);
    if (server && server.status !== "connected") {
      throw new HarnessError("infra", "mcp_not_connected", `harness MCP server status: ${server.status}`);
    }
    state.model = event.model ?? state.model;
    state.toolsChecked = true;
  }
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && !String(block.name).startsWith(PREFIX)) {
        throw new HarnessError(
          "policy_violation",
          "claude_foreign_tool",
          `claude called a tool outside the harness: ${block.name}`,
        );
      }
    }
    state.model = event.message?.model ?? state.model;
  }
  if (event.type === "result") state.result = event;
}

/** @param {import("../../config/runtime.mjs").AdapterSettings} [settings] */
export function createClaudeCodeAdapter(settings = {}) {
  const command = settings.command ?? "claude";
  return {
    name: "claude-code",
    probe() {
      const version = cliVersion(command);
      const problems = [];
      if (!version) problems.push(`${command} not found or --version failed`);
      else if (settings.min_version && compareVersions(version, settings.min_version) < 0)
        problems.push(`claude ${version} is older than ${settings.min_version}`);
      return { adapter: "claude-code", command, version, ok: problems.length === 0, problems };
    },
    /** @param {import("../contract.mjs").Invocation} invocation */
    async run(invocation) {
      const version = cliVersion(command);
      if (!version) throw new HarnessError("infra", "runtime_missing", `${command} is not available`);
      const mcpConfigFile = path.join(invocation.sessionDir, "claude-mcp.json");
      writeFileSync(
        mcpConfigFile,
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "stdio",
              command: process.execPath,
              args: [MCP_ENTRY],
              env: { PANAGENT_SESSION: invocation.sessionFile },
            },
          },
        }),
        { mode: 0o600 },
      );
      const state = { usage: null, model: null, result: null, toolsChecked: false };
      const exit = await runJsonlProcess({
        command,
        args: claudeArgs(invocation, mcpConfigFile),
        cwd: invocation.cwd,
        env: runtimeEnvironment(),
        input: invocation.taskPrompt,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        onEvent: (event) => inspectClaudeEvent(event, state),
      });
      const result = state.result;
      const runtime = {
        adapter: "claude-code",
        adapter_version: version,
        provider: "anthropic",
        model: state.model ?? invocation.model ?? null,
      };
      if (!state.toolsChecked && exit.code === 0) {
        throw new HarnessError("tool_protocol", "claude_no_init", "claude did not report its tool list");
      }
      if (!result || result.is_error || exit.code !== 0) {
        const message = String(
          result?.result ?? result?.subtype ?? exit.stderrTail ?? `claude exited with ${exit.code}`,
        );
        const { errorClass, retryAfter } = classifyProviderMessage(message);
        if (result?.subtype === "error_max_turns")
          throw new HarnessError("agent", "max_turns", "claude reached its turn limit", {
            details: { runtime },
          });
        if (!result)
          throw new HarnessError("infra", "claude_exit", message.slice(0, 500), { details: { runtime } });
        throw new HarnessError(errorClass, "claude_error", message.slice(0, 500), {
          retryAfter,
          details: { runtime },
        });
      }
      const usage = result.usage
        ? {
            input_tokens: result.usage.input_tokens ?? 0,
            cached_input_tokens: result.usage.cache_read_input_tokens ?? 0,
            output_tokens: result.usage.output_tokens ?? 0,
            cost_usd: result.total_cost_usd ?? null,
          }
        : null;
      return { runtime, usage };
    },
  };
}
