// @ts-check
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestJson } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { assertValid } from "../util/schema.mjs";

export const RUNTIME_CONFIG_FILE = "runtimes.json";

/**
 * @typedef {{ adapter: "codex" | "claude-code" | "pi" | "opencode" | "fake", model?: string, provider?: string, effort?: string, variant?: string }} RoleRuntime
 * @typedef {{ command?: string, min_version?: string, provider?: string, script?: string }} AdapterSettings
 * @typedef {{
 *   version: 1,
 *   source: string,
 *   signing?: { key: string, principal: string },
 *   roles: { implementer: RoleRuntime, reviewer: RoleRuntime },
 *   adapters: Record<string, AdapterSettings>,
 *   budgets: { timeout_ms: number, max_tool_calls: number },
 *   retry: { infra: number },
 *   digest: string,
 * }} RuntimeConfig
 */

/**
 * Resolve a role's vendor without starting its adapter. Explicit role providers
 * override adapter settings. Opencode direct model IDs supply a vendor prefix;
 * gateway models need an explicit vendor, otherwise their identity stays unknown.
 * @param {{ adapter: string, model?: string, provider?: string | null }} role
 * @param {{ provider?: string }} [settings]
 * @returns {string}
 */
export function roleProvider(role, settings = {}) {
  if (role.adapter === "codex") return "openai";
  if (role.adapter === "claude-code") return "anthropic";
  if (role.adapter === "fake") return "fake";
  let provider = role.provider ?? settings.provider;
  if (role.adapter === "opencode") {
    provider ??= role.model?.match(/^([^/]+)\/.+$/)?.[1];
    if (provider === "opencode") return "unknown";
  }
  return provider === "openai-codex" ? "openai" : (provider ?? "unknown");
}

export const DEFAULT_BUDGETS = Object.freeze({ timeout_ms: 1200000, max_tool_calls: 150 });

/**
 * Candidate locations, most specific first; repository config requires opt-in.
 * @param {string} repoRoot
 * @param {string | undefined} explicit
 * @param {boolean} [trustRepoRuntimes]
 */
export function runtimeConfigCandidates(repoRoot, explicit, trustRepoRuntimes = false) {
  if (explicit) return [path.resolve(explicit)];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [
    ...(trustRepoRuntimes || process.env.APOCHA_TRUST_REPO_RUNTIMES === "1"
      ? [path.join(repoRoot, ".apocha", RUNTIME_CONFIG_FILE)]
      : []),
    path.join(xdg, "apocha", RUNTIME_CONFIG_FILE),
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
    if (entry.variant !== undefined && entry.adapter !== "opencode") {
      throw new HarnessError(
        "config",
        "variant_not_supported",
        `${source}: roles.${role}.variant is supported only for opencode`,
      );
    }
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
    ...(input.signing
      ? {
          signing: {
            key: path.resolve(
              input.signing.key.startsWith("~/")
                ? path.join(os.homedir(), input.signing.key.slice(2))
                : input.signing.key,
            ),
            principal: input.signing.principal,
          },
        }
      : {}),
  };
  return { ...normalized, source, digest: digestJson(normalized) };
}

/**
 * Load the runtime config. Lookup: explicit path, repository config only with
 * --trust-repo-runtimes or APOCHA_TRUST_REPO_RUNTIMES=1, then
 * `$XDG_CONFIG_HOME/apocha/runtimes.json` (default `~/.config`).
 * @param {string} repoRoot
 * @param {string | undefined} [explicit]
 * @param {boolean} [trustRepoRuntimes]
 * @returns {RuntimeConfig}
 */
export function loadRuntimeConfig(repoRoot, explicit, trustRepoRuntimes = false) {
  const repoConfig = path.join(repoRoot, ".apocha", RUNTIME_CONFIG_FILE);
  if (
    !explicit &&
    !trustRepoRuntimes &&
    process.env.APOCHA_TRUST_REPO_RUNTIMES !== "1" &&
    existsSync(repoConfig)
  ) {
    process.stderr.write(
      `ignored repository runtime config ${repoConfig}; use --trust-repo-runtimes or APOCHA_TRUST_REPO_RUNTIMES=1 to trust it\n`,
    );
  }
  for (const file of runtimeConfigCandidates(repoRoot, explicit, trustRepoRuntimes)) {
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
    "no runtime config found; use --runtimes <file>, create $XDG_CONFIG_HOME/apocha/runtimes.json (default ~/.config/apocha/runtimes.json), or trust .apocha/runtimes.json with --trust-repo-runtimes or APOCHA_TRUST_REPO_RUNTIMES=1 (see docs/configuration.md)",
  );
}
