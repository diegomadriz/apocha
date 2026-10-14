// @ts-check
import { fileURLToPath } from "node:url";
import { HarnessError } from "../util/errors.mjs";

const APOCHA_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));
const MCP_ADAPTERS = new Set(["codex", "claude-code", "pi"]);

/** Resolve from the same directory as mcp-server.mjs, never from the project.
 * @param {(specifier: string) => string} [resolve]
 */
export function checkApochaDependencies(resolve = (specifier) => import.meta.resolve(specifier)) {
  try {
    resolve("@modelcontextprotocol/server");
    resolve("@modelcontextprotocol/server/stdio");
    return { ok: true, detail: APOCHA_DIRECTORY };
  } catch {
    return {
      ok: false,
      detail: `Apocha's own dependencies are not installed in ${APOCHA_DIRECTORY}; run npm ci there`,
    };
  }
}

/**
 * @param {import("../config/runtime.mjs").RuntimeConfig} runtimes
 * @param {{ implementer: import("./contract.mjs").Adapter, reviewer: import("./contract.mjs").Adapter }} adapters
 * @param {(specifier: string) => string} [resolve]
 */
export function assertApochaDependencies(runtimes, adapters, resolve) {
  const names = [
    runtimes.roles.implementer.adapter,
    runtimes.roles.reviewer.adapter,
    adapters.implementer.name,
    adapters.reviewer.name,
  ];
  if (!names.some((name) => MCP_ADAPTERS.has(name))) return;
  const result = checkApochaDependencies(resolve);
  if (!result.ok) throw new HarnessError("infra", "harness_dependencies_missing", result.detail);
}
