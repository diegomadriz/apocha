// @ts-check
import { isTestPath } from "../config/project.mjs";
import { git } from "../util/git.mjs";

export { classifyTestBypasses } from "./test-source.mjs";

/**
 * @param {Pick<import("./candidate.mjs").Candidate, "root" | "base_commit">} candidate
 * @param {import("../config/project.mjs").ProjectConfig} config
 */
export function existingTestFiles(candidate, config) {
  return String(git(candidate.root, ["ls-tree", "-r", "--name-only", "-z", candidate.base_commit]).stdout)
    .split("\0")
    .filter((file) => file && isTestPath(config, file))
    .sort();
}

/** @param {string} line */
function namedImport(line) {
  const match = /^\s*import\s+(?:([\w$]+)\s*,\s*)?\{([^{}]*)\}\s+from\s+(["'])([^"'\\]+)\3\s*;?\s*$/.exec(
    line,
  );
  if (!match) return null;
  const names = match[2]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.every((name) => /^[\w$]+(?:\s+as\s+[\w$]+)?$/.test(name))) return null;
  return {
    module: match[4],
    defaultBinding: match[1] ?? "",
    names: new Set(names.map((name) => name.replace(/\s+/g, " "))),
  };
}

/**
 * Line LCS, allowing a named import to preserve its old specifiers.
 * Strip exact common edges before allocating a bounded table for the middle.
 * Larger middles conservatively require evidence rather than quadratic memory.
 * A null candidate represents deletion, including deletion of an empty file.
 * @param {string} baseText
 * @param {string | null} newText
 * @returns {{ additive: boolean, removed_lines: string[], import_extensions: number }}
 */
export function classifyTestFileChange(baseText, newText) {
  const lines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  let base = lines(baseText);
  if (newText === null) return { additive: false, removed_lines: base.slice(0, 20), import_extensions: 0 };
  let next = lines(newText);
  let prefix = 0;
  while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < next.length - prefix &&
    base[base.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  base = base.slice(prefix, base.length - suffix);
  next = next.slice(prefix, next.length - suffix);
  if ((base.length + 1) * (next.length + 1) > 4_000_000)
    return {
      additive: false,
      removed_lines: ["Cannot prove additivity: unmatched middle exceeds 4,000,000 LCS cells"],
      import_extensions: 0,
    };
  const oldImports = base.map(namedImport);
  const newImports = next.map(namedImport);
  const preserves = (i, j) => {
    if (base[i] === next[j]) return true;
    const old = oldImports[i];
    const added = newImports[j];
    return Boolean(
      old &&
        added &&
        old.module === added.module &&
        old.defaultBinding === added.defaultBinding &&
        [...old.names].every((name) => added.names.has(name)),
    );
  };
  const rows = Array.from({ length: base.length + 1 }, () => new Uint32Array(next.length + 1));
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = next.length - 1; j >= 0; j -= 1) {
      rows[i][j] = preserves(i, j) ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const removed = [];
  let import_extensions = 0;
  let i = 0;
  let j = 0;
  while (i < base.length) {
    if (j < next.length && preserves(i, j)) {
      if (base[i] !== next[j]) import_extensions += 1;
      i += 1;
      j += 1;
    } else if (j < next.length && rows[i][j + 1] > rows[i + 1][j]) {
      j += 1;
    } else {
      removed.push(base[i]);
      i += 1;
    }
  }
  return { additive: removed.length === 0, removed_lines: removed.slice(0, 20), import_extensions };
}

/**
 * @param {import("../config/task.mjs").Task["test_edits"]} policy
 * @param {import("../config/project.mjs").ProjectConfig} config
 */
export function effectiveTestEditPolicy(policy, config) {
  return policy === "justified" && !config.tests.run_files
    ? {
        effective_policy: /** @type {const} */ ("additive"),
        reason: "justified needs tests.run_files to gather evidence; enforcing additive",
      }
    : { effective_policy: policy };
}

/**
 * Classify the staged candidate diff against its base, without rename detection.
 * @param {Pick<import("./candidate.mjs").Candidate, "root" | "base_commit">} candidate
 * @param {import("../config/project.mjs").ProjectConfig} config
 * @param {string[]} changedFiles
 * @param {import("../config/task.mjs").Task["test_edits"]} policy
 */
export function testEdits(candidate, config, changedFiles, policy) {
  const existing = new Set(existingTestFiles(candidate, config));
  const tests = changedFiles.filter((file) => isTestPath(config, file));
  const added = tests.filter((file) => !existing.has(file));
  const modified = tests.filter((file) => existing.has(file));
  const changed = modified.filter((file) => {
    const base = String(git(candidate.root, ["show", `${candidate.base_commit}:${file}`]).stdout);
    const next = git(candidate.root, ["show", `:${file}`], { allowFailure: true });
    return !classifyTestFileChange(base, next.status === 0 ? String(next.stdout) : null).additive;
  });
  const effective = effectiveTestEditPolicy(policy, config);
  const offending =
    effective.effective_policy === "allowed" || effective.effective_policy === "justified"
      ? []
      : effective.effective_policy === "new-files"
        ? modified
        : changed;
  return { policy, ...effective, added, modified, changed, offending };
}
