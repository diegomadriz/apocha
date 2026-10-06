// @ts-check
import { digestJson } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { canonicalPath, hasGitComponent, inAnyScope, inScope, isForbidden } from "../util/paths.mjs";
import { assertValid } from "../util/schema.mjs";
import { selectChecks } from "./project.mjs";

/**
 * @typedef {{
 *   task_id: string,
 *   description: string,
 *   acceptance_criteria: string[],
 *   allowed_paths: string[],
 *   read_only_paths: string[],
 *   protected_paths: string[],
 *   initial_context: string[],
 *   design_reference: string[],
 *   checks: string[],
 *   fixers: string[],
 *   test_edits: "justified" | "additive" | "new-files" | "allowed",
 *   new_tests_must_fail_on_base: boolean,
 *   checks_selected_by_rule: boolean,
 *   fail_fast: boolean,
 *   max_repair_attempts: number,
 * }} Task
 */

/**
 * Validate a task manifest against the schema and the project config, and
 * return its normalized form. `changedFilesHint` is used only when the task
 * names no checks and they must be selected by rule from its allowed paths.
 *
 * @param {unknown} raw
 * @param {import("./project.mjs").ProjectConfig} config
 * @returns {Task}
 */
export function validateTask(raw, config) {
  assertValid("task.schema.json", raw, "task manifest");
  const input = /** @type {Record<string, any>} */ (raw);
  const forbidden = config.paths.forbidden;
  const list = (name) => {
    const values = input[name] ?? [];
    for (const entry of values) {
      canonicalPath(entry, name);
      if (hasGitComponent(entry))
        throw new HarnessError("config", "invalid_path", `${name} may not name .git: ${entry}`);
    }
    return [...values];
  };
  const allowed = list("allowed_paths");
  const readOnly = list("read_only_paths");
  const protectedPaths = list("protected_paths");
  const initial = list("initial_context");
  const design = list("design_reference");

  for (const entry of [...allowed, ...readOnly, ...initial, ...design]) {
    if (isForbidden(entry, forbidden))
      throw new HarnessError("config", "forbidden_path", `task names a forbidden path: ${entry}`);
  }
  for (const entry of initial) {
    if (!inAnyScope(entry, [...allowed, ...readOnly])) {
      throw new HarnessError(
        "config",
        "invalid_path",
        `initial_context entry ${entry} is outside allowed_paths and read_only_paths; add it to read_only_paths to let the agent read it without editing it`,
      );
    }
  }
  for (const entry of design) {
    if (entry.endsWith("/") || !inScope(entry, config.paths.design_reference_prefix)) {
      throw new HarnessError(
        "config",
        "invalid_path",
        `design_reference must be a file under ${config.paths.design_reference_prefix}: ${entry}`,
      );
    }
  }

  let checks = input.checks ? [...input.checks] : null;
  for (const id of checks ?? []) {
    if (!Object.hasOwn(config.checks, id))
      throw new HarnessError("config", "unknown_check", `unknown check ID: ${id}`);
  }
  const selectedByRule = checks === null;
  if (checks === null) checks = selectChecks(config, allowed);

  const fixers = [...(input.fixers ?? config.default_fixers)];
  for (const id of fixers) {
    if (!Object.hasOwn(config.fixers, id))
      throw new HarnessError("config", "unknown_fixer", `unknown fixer ID: ${id}`);
  }

  const repairs = input.max_repair_attempts ?? config.limits.default_repair_attempts;
  if (repairs > config.limits.max_repair_attempts) {
    throw new HarnessError(
      "config",
      "repair_limit",
      `max_repair_attempts ${repairs} exceeds the project limit ${config.limits.max_repair_attempts}`,
    );
  }
  return {
    task_id: input.task_id,
    description: input.description,
    acceptance_criteria: [...input.acceptance_criteria],
    allowed_paths: allowed,
    read_only_paths: readOnly,
    protected_paths: protectedPaths,
    initial_context: initial,
    design_reference: design,
    checks,
    fixers,
    test_edits: input.test_edits ?? "justified",
    new_tests_must_fail_on_base: input.new_tests_must_fail_on_base ?? false,
    checks_selected_by_rule: selectedByRule,
    fail_fast: input.fail_fast ?? false,
    max_repair_attempts: repairs,
  };
}

/** Digest of the task contract, recorded in run metadata and receipts. @param {Task} task */
export function taskDigest(task) {
  return digestJson(task);
}

/**
 * Every path the candidate must not change, given the project config and
 * whether governance edits are allowed for this run.
 * @param {Task} task
 * @param {import("./project.mjs").ProjectConfig} config
 * @param {boolean} allowGovernanceEdits
 */
export function effectiveProtectedPaths(task, config, allowGovernanceEdits) {
  return [
    ...new Set([
      ...config.paths.protected,
      ...config.paths.forbidden,
      ...(allowGovernanceEdits ? [] : config.paths.governance),
      ...task.protected_paths,
      ...task.design_reference,
    ]),
  ];
}
