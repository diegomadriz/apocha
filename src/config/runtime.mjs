// @ts-check
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestJson } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { assertValid } from "../util/schema.mjs";

export const RUNTIME_CONFIG_FILE = "runtimes.json";

/**
 * @typedef {{ adapter: "codex" | "claude-code" | "pi" | "fake", model?: string, provider?: string, effort?: string }} RoleRuntime
 * @typedef {{ command?: string, min_version?: string, provider?: string, script?: string }} AdapterSettings
 * @typedef {{
 *   version: 1,
 *   source: string,
 *   roles: { implementer: RoleRuntime, reviewer: RoleRuntime },
 *   adapters: Record<string, AdapterSettings>,
 *   budgets: { timeout_ms: number, max_tool_calls: number },
 *   retry: { infra: number },
 *   digest: string,
 * }} RuntimeConfig
 */

export const DEFAULT_BUDGETS = Object.freeze({ timeout_ms: 1200000, max_tool_calls: 150 });

/** Candidate locations, most specific first. @param {string} repoRoot @param {string | undefined} explicit */
export function runtimeConfigCandidates(repoRoot, explicit) {
  if (explicit) return [path.resolve(explicit)];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [
    path.join(repoRoot, ".panagent", RUNTIME_CONFIG_FILE),
    path.join(xdg, "panagent", RUNTIME_CONFIG_FILE),
  ];
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @returns {RuntimeConfig}
 */
export function normalizeRuntimeConfig(raw, source) {
  assertValid("runtime-config.schema.json", raw, source);
  const input = /** @type {Record<string, any>} */ (raw);
  for (const role of ["implementer", "reviewer"]) {
    const entry = input.roles[role];
    if (entry.adapter !== "fake" && !entry.model) {
      throw new HarnessError(
        "config",
        "model_required",
        `${source}: roles.${role}.model is required for ${entry.adapter}`,
      );
    }
  }
  const normalized = {
    version: /** @type {1} */ (1),
    roles: { implementer: { ...input.roles.implementer }, reviewer: { ...input.roles.reviewer } },
    adapters: { ...(input.adapters ?? {}) },
    budgets: { ...DEFAULT_BUDGETS, ...(input.budgets ?? {}) },
    retry: { infra: 1, ...(input.retry ?? {}) },
  };
  return { ...normalized, source, digest: digestJson(normalized) };
}

/**
 * Load the runtime config. Lookup: explicit path, `<repo>/.panagent/runtimes.json`,
 * then `$XDG_CONFIG_HOME/panagent/runtimes.json`.
 * @param {string} repoRoot
 * @param {string | undefined} [explicit]
 * @returns {RuntimeConfig}
 */
export function loadRuntimeConfig(repoRoot, explicit) {
  for (const file of runtimeConfigCandidates(repoRoot, explicit)) {
    if (!existsSync(file)) {
      if (explicit)
        throw new HarnessError("config", "missing_runtime_config", `runtime config not found: ${file}`);
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new HarnessError("config", "invalid_json", `${file} is not valid JSON: ${error.message}`);
    }
    return normalizeRuntimeConfig(raw, file);
  }
  throw new HarnessError(
    "config",
    "missing_runtime_config",
    "no runtime config found; create .panagent/runtimes.json or ~/.config/panagent/runtimes.json (see docs/configuration.md)",
  );
}
