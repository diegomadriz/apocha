// @ts-check
import { HarnessError } from "../util/errors.mjs";
import { createClaudeCodeAdapter } from "./claude-code/index.mjs";
import { createCodexAdapter } from "./codex/index.mjs";
import { createFakeAdapter } from "./fake/index.mjs";
import { createOpencodeAdapter } from "./opencode/index.mjs";
import { createPiAdapter } from "./pi/index.mjs";

/**
 * Build the adapter for a role from the runtime config.
 * @param {import("../config/runtime.mjs").RuntimeConfig} runtimes
 * @param {"implementer" | "reviewer"} role
 * @returns {import("./contract.mjs").Adapter}
 */
export function adapterForRole(runtimes, role) {
  const entry = runtimes.roles[role];
  const settings = runtimes.adapters[entry.adapter] ?? {};
  switch (entry.adapter) {
    case "codex":
      return createCodexAdapter(settings);
    case "claude-code":
      return createClaudeCodeAdapter(settings);
    case "pi":
      return createPiAdapter(settings);
    case "opencode":
      return createOpencodeAdapter(settings);
    case "fake":
      return createFakeAdapter({ script: settings.script });
    default:
      throw new HarnessError("config", "unknown_adapter", `unknown adapter: ${entry.adapter}`);
  }
}

export {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createFakeAdapter,
  createOpencodeAdapter,
  createPiAdapter,
};
