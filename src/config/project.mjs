// @ts-check
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { digestJson } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git } from "../util/git.mjs";
import { canonicalPath, hasGitComponent } from "../util/paths.mjs";
import { assertValid } from "../util/schema.mjs";

export const PROJECT_CONFIG_FILE = "apocha.config.json";
export const LOCAL_CONFIG_DIR = ".apocha/";
/** Config file and local directory names used before the rename from Panagent; still read and protected. */
export const LEGACY_PROJECT_CONFIG_FILES = Object.freeze(["panagent.config.json"]);
export const LEGACY_LOCAL_CONFIG_DIRS = Object.freeze([".panagent/"]);

/** Credential locations no check may read, on top of the project's own list. */
export const DEFAULT_DENY_READ = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.codex",
  "~/.claude",
  "~/.pi",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.docker",
  "~/.kube",
  "~/.git-credentials",
  "~/Library/Keychains",
]);

/** Local daemon sockets no sandboxed check may connect to. */
export const DEFAULT_DENY_SOCKETS = Object.freeze([
  "/var/run/docker.sock",
  "/run/docker.sock",
  "~/.docker/run/docker.sock",
  "~/.colima/default/docker.sock",
  "~/.orbstack/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
  "~/.local/share/containers/podman/machine/podman.sock",
]);

export const DEFAULT_LIMITS = Object.freeze({
  max_repair_attempts: 2,
  default_repair_attempts: 1,
  review_diff_bytes: 400000,
  run_check_calls: 6,
  check_output_bytes: 20000,
});

/**
 * @typedef {{ id: string, run: string[], cwd: string, timeout_ms: number, dependencies: "none" | "npm", network: boolean, env: Record<string, string>, description?: string }} CheckDefinition
 * @typedef {{
 *   version: 1,
 *   root: string,
 *   checks: Record<string, CheckDefinition>,
 *   check_selection: { paths: string[], checks: string[] }[],
 *   default_checks: string[],
 *   tests: { paths: string[], run_files?: CheckDefinition },
 *   paths: { protected: string[], governance: string[], forbidden: string[], design_reference_prefix: string },
 *   refs: { batch_prefix: string, notes: string },
 *   sandbox: { mode: "auto" | "required" | "none", network: "deny" | "allow", deny_read: string[], deny_sockets: string[] },
 *   limits: typeof DEFAULT_LIMITS,
 *   digest: string,
 * }} ProjectConfig
 */

/**
 * Normalize a raw project config document (already parsed JSON).
 * @param {unknown} raw
 * @param {string} root absolute repository root
 * @returns {ProjectConfig}
 */
export function normalizeProjectConfig(raw, root) {
  assertValid("project-config.schema.json", raw, PROJECT_CONFIG_FILE);
  const input = /** @type {Record<string, any>} */ (raw);
  /** @type {Record<string, CheckDefinition>} */
  const checks = {};
  /** @param {string} id @param {Record<string, any>} check @returns {CheckDefinition} */
  const normalizeCheck = (id, check) => {
    const cwd = check.cwd ?? ".";
    if (cwd !== ".") canonicalPath(cwd, `checks.${id}.cwd`);
    return {
      id,
      run: [...check.run],
      cwd,
      timeout_ms: check.timeout_ms ?? 300000,
      dependencies: check.dependencies ?? "none",
      network: check.network ?? false,
      env: { ...(check.env ?? {}) },
      ...(check.description ? { description: check.description } : {}),
    };
  };
  for (const [id, check] of Object.entries(input.checks)) {
    checks[id] = normalizeCheck(id, check);
  }
  if (input.tests?.run_files && input.tests.run_files.run.filter((part) => part === "{files}").length !== 1) {
    throw new HarnessError(
      "config",
      "invalid_test_command",
      "tests.run_files.run must contain exactly one {files} element",
    );
  }
  const known = (id, where) => {
    if (!Object.hasOwn(checks, id))
      throw new HarnessError("config", "unknown_check", `${where} names unknown check: ${id}`);
  };
  const selection = (input.check_selection ?? []).map((rule, index) => {
    for (const entry of rule.paths) canonicalPath(entry, `check_selection[${index}].paths`);
    for (const id of rule.checks) known(id, `check_selection[${index}]`);
    return { paths: [...rule.paths], checks: [...rule.checks] };
  });
  const defaults = [...(input.default_checks ?? [])];
  for (const id of defaults) known(id, "default_checks");

  const pathList = (list, label) =>
    (list ?? []).map((entry) => {
      canonicalPath(entry, label);
      if (hasGitComponent(entry))
        throw new HarnessError("config", "invalid_path", `${label} may not name .git`);
      return entry;
    });
  const governance = [
    ...new Set([
      PROJECT_CONFIG_FILE,
      LOCAL_CONFIG_DIR,
      ...LEGACY_PROJECT_CONFIG_FILES,
      ...LEGACY_LOCAL_CONFIG_DIRS,
      ...pathList(input.paths?.governance, "paths.governance"),
    ]),
  ];
  const designPrefix = input.paths?.design_reference_prefix ?? "docs/design/";
  canonicalPath(designPrefix, "paths.design_reference_prefix");
  if (!designPrefix.endsWith("/")) {
    throw new HarnessError("config", "invalid_path", "paths.design_reference_prefix must end with '/'");
  }

  const normalized = {
    version: /** @type {1} */ (1),
    root,
    checks,
    check_selection: selection,
    default_checks: defaults,
    tests: {
      ...(input.tests?.run_files
        ? { run_files: normalizeCheck("tests-on-base", input.tests.run_files) }
        : {}),
      paths: pathList(
        input.tests?.paths ?? ["test/", "tests/", "__tests__/", "*.test.*", "*.spec.*"],
        "tests.paths",
      ),
    },
    paths: {
      protected: pathList(input.paths?.protected, "paths.protected"),
      governance,
      forbidden: pathList(input.paths?.forbidden, "paths.forbidden"),
      design_reference_prefix: designPrefix,
    },
    refs: {
      batch_prefix: input.refs?.batch_prefix ?? "refs/heads/apocha/batch/",
      notes: input.refs?.notes ?? "refs/notes/apocha",
    },
    sandbox: {
      mode: input.sandbox?.mode ?? "auto",
      network: input.sandbox?.network ?? "deny",
      deny_read: [...new Set([...DEFAULT_DENY_READ, ...(input.sandbox?.deny_read ?? [])])],
      deny_sockets: [...new Set([...DEFAULT_DENY_SOCKETS, ...(input.sandbox?.deny_sockets ?? [])])],
    },
    limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) },
  };
  if (normalized.limits.default_repair_attempts > normalized.limits.max_repair_attempts) {
    normalized.limits.default_repair_attempts = normalized.limits.max_repair_attempts;
  }
  const { root: _root, ...hashed } = normalized;
  return { ...normalized, digest: digestJson(hashed) };
}

/**
 * Load `apocha.config.json` (or the legacy `panagent.config.json`) from a repository root, or from a specific
 * Git tree when `readFile` is supplied (the base commit's config governs a run,
 * never a config the candidate could have edited).
 *
 * @param {string} root
 * @param {{ readFile?: (relative: string) => string | null }} [options]
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(root, options = {}) {
  /** @param {string} name */
  const read = (name) => {
    if (options.readFile) return options.readFile(name);
    const file = path.join(root, name);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  let text = null;
  for (const name of [PROJECT_CONFIG_FILE, ...LEGACY_PROJECT_CONFIG_FILES]) {
    text = read(name);
    if (text !== null) break;
  }
  if (text === null) {
    throw new HarnessError(
      "config",
      "missing_project_config",
      `${PROJECT_CONFIG_FILE} not found; run 'apocha init'`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HarnessError(
      "config",
      "invalid_json",
      `${PROJECT_CONFIG_FILE} is not valid JSON: ${error.message}`,
    );
  }
  return normalizeProjectConfig(raw, root);
}

/**
 * Checks for a set of changed files: every matching selection rule plus defaults.
 * @param {ProjectConfig} config
 * @param {string[]} changedFiles
 */
export function selectChecks(config, changedFiles) {
  const selected = new Set(config.default_checks);
  for (const rule of config.check_selection) {
    if (
      changedFiles.some((file) =>
        rule.paths.some((scope) => (scope.endsWith("/") ? file.startsWith(scope) : file === scope)),
      )
    ) {
      for (const id of rule.checks) selected.add(id);
    }
  }
  return Object.keys(config.checks).filter((id) => selected.has(id));
}

/**
 * Match test directory prefixes, basename wildcards, or exact repository paths.
 * @param {ProjectConfig} config
 * @param {string} relativePath
 */
export function isTestPath(config, relativePath) {
  return config.tests.paths.some((entry) => {
    if (entry.endsWith("/")) return relativePath.startsWith(entry);
    if (!entry.includes("*")) return relativePath === entry;
    const pattern = entry
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${pattern}$`).test(path.posix.basename(relativePath));
  });
}

/**
 * Load the project config as it is in a given commit.
 * @param {string} root
 * @param {string} commit
 */
export function loadProjectConfigAt(root, commit) {
  return loadProjectConfig(root, {
    readFile: (relative) => {
      const result = git(root, ["show", `${commit}:${relative}`], { allowFailure: true });
      return result.status === 0 ? String(result.stdout) : null;
    },
  });
}
