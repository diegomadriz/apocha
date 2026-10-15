// @ts-check
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../util/digest.mjs";
import { resolveInside } from "../util/fs-safe.mjs";
import { inAnyScope, isForbidden } from "../util/paths.mjs";
import { checkDefinitionDigest, runCheck } from "./runner.mjs";

/** @typedef {{ id: string, definition_digest: string, status: import("./runner.mjs").CheckResult["status"], changed: string[], ignored_changes: string[] }} FixerResult */

/**
 * Snapshot candidate files without following symlinks or opening special files.
 * @param {string} root
 * @param {string[]} excludedPaths Harness-materialized directories, never candidate files.
 */
function treeFiles(root, excludedPaths) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  /** @param {string} relative */
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    if (excludedPaths.includes(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
    } else {
      const identity = stat.isFile()
        ? sha256(readFileSync(absolute))
        : stat.isSymbolicLink()
          ? readlinkSync(absolute)
          : "special";
      entries.set(relative, `${stat.mode}:${identity}`);
    }
  };
  visit("");
  return entries;
}

/**
 * Fixers can update existing eligible regular files, never tree structure.
 * @param {import("../core/context.mjs").RunContext} ctx
 * @param {string[]} changedFiles
 * @returns {Promise<FixerResult[]>}
 */
export async function runFixers(ctx, changedFiles) {
  const selected = ctx.task.fixers ?? ctx.config.default_fixers;
  if (!selected.length) return [];
  const blocked = [
    ...ctx.config.paths.protected,
    ...ctx.config.paths.forbidden,
    ...ctx.config.paths.governance,
    ...ctx.task.protected_paths,
    ...ctx.task.read_only_paths,
    ...ctx.task.design_reference,
  ];
  const files = changedFiles.filter(
    (file) =>
      inAnyScope(file, ctx.task.allowed_paths) &&
      !inAnyScope(file, blocked) &&
      !isForbidden(file, ctx.config.paths.forbidden) &&
      lstatExists(ctx.candidate.root, file),
  );
  /** @type {FixerResult[]} */
  const results = [];
  for (const id of selected) {
    const check = ctx.config.fixers[id];
    /** @type {FixerResult} */
    const evidence = {
      id,
      definition_digest: checkDefinitionDigest(check),
      status: "skipped",
      changed: [],
      ignored_changes: [],
    };
    if (files.length) {
      let before = new Map();
      /** @type {string[]} */
      let excludedPaths = [];
      /** @type {Map<string, Buffer>} */
      const updates = new Map();
      const result = await runCheck({
        check,
        candidate: ctx.candidate,
        config: ctx.config,
        backend: ctx.sandboxBackend,
        signingKey: ctx.runtimes?.signing?.key,
        secretFileCache: (ctx.secretFileCache ??= { files: new Map() }),
        dependencyOptions: { onValidation: (source) => ctx.event("dependencies.validation", { source }) },
        signal: ctx.signal,
        files: files.map((file) => path.posix.relative(check.cwd, file)),
        onPrepared: (root, excluded) => {
          excludedPaths = excluded;
          before = treeFiles(root, excludedPaths);
        },
        onFinished: (root, status) => {
          const after = treeFiles(root, excludedPaths);
          for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
            if (before.get(file) === after.get(file)) continue;
            if (status === "pass" && files.includes(file) && after.has(file)) {
              try {
                const source = resolveInside(root, file).absolute;
                const stat = lstatSync(source);
                if (stat.isFile() && stat.nlink === 1) {
                  updates.set(file, readFileSync(source));
                  continue;
                }
              } catch {
                /* Unsafe replacements are ignored. */
              }
            }
            evidence.ignored_changes.push(file);
          }
        },
      });
      evidence.status = result.status;
      // Cleanup failures also prevent copy-back.
      if (result.status === "pass") {
        for (const [file, buffer] of updates) {
          const target = resolveInside(ctx.candidate.root, file).absolute;
          if (!readFileSync(target).equals(buffer)) {
            writeFileSync(target, buffer);
            evidence.changed.push(file);
          }
        }
      }
    }
    results.push(evidence);
    ctx.event("fixer.finished", { ...evidence });
  }
  return results;
}

/** @param {string} root @param {string} file */
function lstatExists(root, file) {
  try {
    return lstatSync(resolveInside(root, file).absolute).isFile();
  } catch {
    return false;
  }
}
