// @ts-check
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { collectRunFacts } from "../analytics/collect.mjs";
import { loadProjectConfig } from "../config/project.mjs";
import { HarnessError } from "../util/errors.mjs";
import { resolveInside, writeJsonAtomic } from "../util/fs-safe.mjs";
import { git, gitCommonDir, gitText, isCanonicalRef, resolveCommit } from "../util/git.mjs";
import { listTempDirs } from "../util/temp.mjs";
import { withLock } from "./lock.mjs";
import { RunStore, stateDir, TERMINAL } from "./runs.mjs";

/**
 * @typedef {{ keepDays?: number, abandonPausedDays?: number, target?: string }} GcOptions
 * @typedef {{ kind: string, path?: string, ref?: string, oid?: string, run_id?: string, size?: number, reason: string }} GcItem
 * @typedef {{ target: string, options: GcOptions, items: GcItem[], total_size: number }} GcPlan
 */

const DAY = 86400000;

/** @param {number | undefined} value @param {string} name */
function checkDays(value, name) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0))
    throw new HarnessError("config", "usage", `--${name} must be a nonnegative number of days`);
}

/** @param {number} pid */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Size without following symlinks. @param {string} directory @returns {number} */
function sizeOf(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(directory).reduce((sum, name) => sum + sizeOf(path.join(directory, name)), 0);
}

/** @param {Record<string, any>} run @param {string} directory */
function candidateIn(run, directory) {
  if (typeof run.candidate_root !== "string") return false;
  const candidate = path.resolve(run.candidate_root);
  const root = realpathSync(directory);
  return candidate === root || candidate === path.join(root, "tree");
}

/** Plan only; does not create locks, records, or directories.
 * @param {string} repositoryRoot @param {GcOptions} [options] @returns {GcPlan}
 */
export function planGc(repositoryRoot, options = {}) {
  checkDays(options.keepDays, "keep-days");
  checkDays(options.abandonPausedDays, "abandon-paused-days");
  const common = realpathSync(gitCommonDir(repositoryRoot));
  resolveInside(common, "apocha", { allowMissing: true });
  const worktrees = gitText(repositoryRoot, ["worktree", "list", "--porcelain"]);
  const mainBranch = worktrees
    .split("\n\n")[0]
    .split("\n")
    .find((line) => line.startsWith("branch "));
  const target = options.target ?? mainBranch?.slice(18) ?? "main";
  const targetRef = `refs/heads/${target}`;
  if (!isCanonicalRef(repositoryRoot, targetRef) || target.startsWith("refs/") || target.startsWith("-"))
    throw new HarnessError("config", "invalid_target", "target must be a branch name");
  const head = resolveCommit(repositoryRoot, targetRef);
  if (!head) throw new HarnessError("config", "unknown_target", `unknown target branch: ${target}`);
  const prefix = loadProjectConfig(repositoryRoot).refs.batch_prefix;
  const store = new RunStore(repositoryRoot);
  const runs = store.list().filter((run) => !run.unreadable);
  const now = Date.now();
  const abandoned = runs.filter(
    (run) =>
      run.outcome === "PAUSED" &&
      options.abandonPausedDays !== undefined &&
      Date.parse(run.updated_at ?? run.created_at) < now - options.abandonPausedDays * DAY,
  );
  const abandonIds = new Set(abandoned.map((run) => run.run_id));
  const protectedRuns = runs.filter(
    (run) => (run.outcome === "RUNNING" || run.outcome === "PAUSED") && !abandonIds.has(run.run_id),
  );
  /** @type {GcItem[]} */
  const items = [];
  for (const run of abandoned) {
    resolveInside(common, path.relative(common, store.dir(run.run_id)));
    items.push({
      kind: "abandon",
      path: store.dir(run.run_id),
      run_id: run.run_id,
      reason: "paused retention expired",
    });
  }
  const refs = gitText(repositoryRoot, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  for (const line of refs.split("\n").filter(Boolean)) {
    const [ref, oid] = line.split(" ");
    if (!ref.startsWith(prefix) || ref.length <= prefix.length || ref === targetRef) continue;
    if (worktrees.split("\n").includes(`branch ${ref}`)) continue;
    if (protectedRuns.some((run) => run.batch_ref === ref || run.base_ref === ref)) continue;
    if (git(repositoryRoot, ["symbolic-ref", "-q", ref], { allowFailure: true }).status === 0) continue;
    const reservation = abandoned.some((run) => run.batch_ref === ref && run.base_commit === oid);
    const merged =
      git(repositoryRoot, ["merge-base", "--is-ancestor", oid, head], { allowFailure: true }).status === 0;
    if (reservation || merged)
      items.push({
        kind: "ref",
        ref,
        oid,
        reason: reservation ? "abandoned batch reservation" : "ancestor of target",
      });
  }
  for (const entry of listTempDirs()) {
    if (protectedRuns.some((run) => candidateIn(run, entry.path) || run.run_id === entry.owner?.run_id))
      continue;
    if (entry.owner?.repository !== undefined) {
      if (entry.owner.repository !== common || alive(entry.owner.pid)) continue;
    } else {
      if (runs.some((run) => candidateIn(run, entry.path))) continue;
      if (lstatSync(entry.path).mtimeMs >= now - DAY) continue;
    }
    const abandoning = abandoned.some((run) => candidateIn(run, entry.path));
    items.push({
      kind: "temp",
      path: entry.path,
      size: sizeOf(entry.path),
      reason: abandoning
        ? "abandoned candidate"
        : entry.owner?.repository !== undefined
          ? "owner pid is dead"
          : "unowned for more than one day",
    });
  }
  for (const run of runs) {
    if (!TERMINAL.has(run.outcome) || !(Date.parse(run.finished_at) < now - (options.keepDays ?? 30) * DAY))
      continue;
    const sessions = path.join(store.dir(run.run_id), "sessions");
    if (!resolveInside(common, path.relative(common, sessions), { allowMissing: true }).exists) continue;
    for (const name of readdirSync(sessions).filter((name) => /^\d{3}$/.test(name))) {
      const directory = path.join(sessions, name);
      resolveInside(common, path.relative(common, directory));
      if (lstatSync(directory).isDirectory())
        items.push({
          kind: "session",
          path: directory,
          run_id: run.run_id,
          size: sizeOf(directory),
          reason: "finished run retention expired",
        });
    }
  }
  items.push({ kind: "worktree", reason: "prune stale worktree registrations" });
  return {
    target,
    options: { ...options, target },
    items,
    total_size: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
  };
}

/** @param {GcItem} item */
function itemKey(item) {
  return JSON.stringify([item.kind, item.path, item.ref, item.oid, item.run_id]);
}

/** Revalidate the supplied plan under the repository lock before applying it.
 * @param {string} repositoryRoot @param {GcPlan} plan
 */
export async function applyGc(repositoryRoot, plan) {
  resolveInside(gitCommonDir(repositoryRoot), "apocha", { allowMissing: true });
  return withLock(stateDir(repositoryRoot), "gc", () => {
    const fresh = planGc(repositoryRoot, plan.options);
    const eligible = new Set(fresh.items.map(itemKey));
    const store = new RunStore(repositoryRoot);
    const facts = new Map(collectRunFacts(repositoryRoot).map((fact) => [fact.run_id, fact]));
    /** @type {GcItem[]} */
    const done = [];
    /** @type {GcItem[]} */
    const skipped = [];
    for (const item of plan.items) {
      if (!eligible.has(itemKey(item))) {
        skipped.push({ ...item, reason: "no longer eligible" });
        continue;
      }
      if (item.kind === "abandon" && item.run_id) {
        const run = store.read(item.run_id);
        const error = { error_class: "infra", code: "abandoned", message: "paused run abandoned by gc" };
        const patch = {
          outcome: "ERROR",
          reason: error.message,
          error_class: error.error_class,
          code: error.code,
          finished_at: new Date().toISOString(),
          state: { ...run.state, error },
        };
        store.writeReport(item.run_id, { ...run, ...patch });
        store.update(item.run_id, patch);
        store.event(item.run_id, "run.finished", { outcome: "ERROR", reason: error.message, ...error });
      } else if (item.kind === "ref" && item.ref && item.oid) {
        const deletion = git(repositoryRoot, ["update-ref", "--no-deref", "-d", item.ref, item.oid], {
          allowFailure: true,
        });
        if (deletion.status !== 0) {
          skipped.push({ ...item, reason: "ref moved or deletion failed" });
          continue;
        }
      } else if (item.kind === "session" && item.path && item.run_id) {
        const fact = facts.get(item.run_id);
        if (!fact) {
          skipped.push({ ...item, reason: "analytics could not be preserved" });
          continue;
        }
        const run = store.read(item.run_id);
        const archived = new Set(run.pruned_sessions ?? []);
        for (const name of readdirSync(path.dirname(item.path)).filter((name) => /^\d{3}$/.test(name)))
          archived.add(name);
        store.update(item.run_id, { archived_tools: fact.tools, pruned_sessions: [...archived] });
        rmSync(item.path, { recursive: true, force: true });
      } else if (item.kind === "temp" && item.path) {
        if (existsSync(item.path)) rmSync(item.path, { recursive: true, force: true });
      } else if (item.kind === "worktree") {
        git(repositoryRoot, ["worktree", "prune"]);
      }
      done.push(item);
    }
    const timestamp = new Date().toISOString();
    const record = path.join(
      stateDir(repositoryRoot),
      "gc",
      `${timestamp.replaceAll(":", "-")}-${process.pid}.json`,
    );
    resolveInside(gitCommonDir(repositoryRoot), path.relative(gitCommonDir(repositoryRoot), record), {
      allowMissing: true,
    });
    const result = {
      created_at: timestamp,
      target: fresh.target,
      done,
      skipped,
      total_size: done.reduce((sum, item) => sum + (item.size ?? 0), 0),
      record,
    };
    writeJsonAtomic(record, result);
    return result;
  });
}
