// @ts-check
import { isTestPath } from "../config/project.mjs";
import { git } from "../util/git.mjs";

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
  const numstat = String(
    git(candidate.root, [
      "diff",
      "--cached",
      "--no-renames",
      "--no-ext-diff",
      "--numstat",
      "-z",
      candidate.base_commit,
      "--",
    ]).stdout,
  );
  const removed = new Set(
    numstat
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const match = /^[^\t]+\t([^\t]+)\t([\s\S]+)$/.exec(entry);
        return match && match[1] !== "0" ? [match[2]] : [];
      }),
  );
  const deleted = new Set(
    String(
      git(candidate.root, [
        "diff",
        "--cached",
        "--no-renames",
        "--name-only",
        "--diff-filter=D",
        "-z",
        candidate.base_commit,
        "--",
      ]).stdout,
    )
      .split("\0")
      .filter(Boolean),
  );
  const offending =
    policy === "allowed"
      ? []
      : modified.filter((file) => policy === "new-files" || removed.has(file) || deleted.has(file));
  return { policy, added, modified, offending };
}
