// @ts-check
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadProjectConfigAt } from "../config/project.mjs";
import { verifyReceipt } from "../git/receipts.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git, gitCommonDir, gitText, isCanonicalRef, resolveCommit } from "../util/git.mjs";
import { listTempDirs } from "../util/temp.mjs";
import { OUTCOMES, RunStore, stateDir } from "./runs.mjs";

/** Bytes without following symlinks. Missing paths may disappear during inventory.
 * @param {string} file @returns {number}
 */
function sizeOf(file) {
  try {
    const stat = lstatSync(file);
    return stat.isDirectory()
      ? readdirSync(file).reduce((sum, name) => sum + sizeOf(path.join(file, name)), 0)
      : stat.size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

/** @param {string} directory @returns {Record<string, any> | null} */
function lastRecord(directory) {
  if (!existsSync(directory)) return null;
  const records = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
        return typeof record?.created_at === "string" ? [record] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return records[0] ?? null;
}

/** Read-only repository inventory; never creates state directories or locks.
 * @param {string} repositoryRoot @param {{ target?: string }} [options]
 */
export function repositoryStatus(repositoryRoot, options = {}) {
  const worktrees = gitText(repositoryRoot, ["worktree", "list", "--porcelain"]).split("\n\n");
  const branchOf = (entry) =>
    entry
      .split("\n")
      .find((line) => line.startsWith("branch "))
      ?.slice(7);
  const name = options.target ?? branchOf(worktrees[0])?.slice(11) ?? "main";
  const ref = `refs/heads/${name}`;
  if (name.startsWith("-") || name.startsWith("refs/") || !isCanonicalRef(repositoryRoot, ref))
    throw new HarnessError("config", "invalid_target", "target must be a branch name");
  const tip = resolveCommit(repositoryRoot, ref);
  if (!tip) throw new HarnessError("config", "unknown_target", `unknown target branch: ${name}`);
  const checkout = worktrees.find((entry) => branchOf(entry) === ref);
  const worktree =
    checkout
      ?.split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9) ?? null;
  // Disable Git's optional index refresh so even a dirty status leaves the index untouched.
  const clean =
    worktree === null
      ? null
      : !String(
          git(worktree, ["status", "--porcelain", "--untracked-files=all"], {
            env: { GIT_OPTIONAL_LOCKS: "0" },
          }).stdout,
        ).trim();
  const config = loadProjectConfigAt(repositoryRoot, tip);
  const store = new RunStore(repositoryRoot);
  const runs = store.list();
  const ancestor = (a, b) =>
    git(repositoryRoot, ["merge-base", "--is-ancestor", a, b], { allowFailure: true }).status === 0;
  const batches = gitText(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    config.refs.batch_prefix,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [batchRef, oid] = line.split(" ");
      return { ref: batchRef, tip: oid };
    })
    .filter(
      (batch) =>
        batch.ref.startsWith(config.refs.batch_prefix) && batch.ref.length > config.refs.batch_prefix.length,
    )
    .map((batch) => {
      const commits = gitText(repositoryRoot, ["rev-list", `${tip}..${batch.tip}`])
        .split("\n")
        .filter(Boolean);
      const receipts = commits.map((commit) => {
        const check = verifyReceipt(repositoryRoot, config.refs.notes, commit);
        return { commit, valid: check.valid, reason: check.reason };
      });
      const receipted = receipts.every((receipt) => receipt.valid);
      const behind = Number(gitText(repositoryRoot, ["rev-list", "--count", `${batch.tip}..${tip}`]));
      const firstParent = gitText(repositoryRoot, ["rev-list", "--first-parent", batch.tip])
        .split("\n")
        .includes(tip);
      const state = ancestor(batch.tip, tip)
        ? "landed"
        : !ancestor(tip, batch.tip) || !firstParent
          ? "diverged"
          : receipted
            ? "ready"
            : "unreceipted";
      const receipt = verifyReceipt(repositoryRoot, config.refs.notes, batch.tip);
      const producer = runs.find(
        (run) => run.promoted_head === batch.tip || (receipt.valid && run.run_id === receipt.receipt.run_id),
      );
      return {
        ...batch,
        ahead: commits.length,
        behind,
        receipted,
        receipts,
        run: producer
          ? { run_id: producer.run_id, outcome: producer.outcome }
          : receipt.valid && receipt.receipt.run_id
            ? { run_id: receipt.receipt.run_id, outcome: null }
            : null,
        state,
      };
    });
  const byOutcome = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const run of runs) byOutcome[run.outcome] = (byOutcome[run.outcome] ?? 0) + 1;
  const attention = runs
    .filter((run) => run.stale || ["RUNNING", "PAUSED", "STALE"].includes(run.outcome))
    .map((run) => ({
      run_id: run.run_id,
      outcome: run.outcome,
      state: run.stale ? "STALE" : run.outcome,
      awaiting: run.state?.awaiting ?? run.awaiting ?? run.reason ?? null,
    }));
  const common = realpathSync(gitCommonDir(repositoryRoot));
  const temp = { owned: { count: 0, size: 0 }, other: { count: 0, size: 0 }, orphan_count: 0 };
  for (const entry of listTempDirs()) {
    const candidates = runs.filter(
      (run) =>
        typeof run.candidate_root === "string" &&
        [path.resolve(entry.path), path.join(path.resolve(entry.path), "tree")].includes(
          path.resolve(run.candidate_root),
        ),
    );
    const owned =
      entry.owner?.repository === common || (entry.owner?.repository === undefined && candidates.length > 0);
    const group = owned ? temp.owned : temp.other;
    group.count++;
    group.size += sizeOf(entry.path);
    if (
      runs.some(
        (run) =>
          ["RUNNING", "PAUSED"].includes(run.outcome) &&
          (candidates.includes(run) || (owned && run.run_id === entry.owner?.run_id)),
      )
    )
      continue;
    if (entry.owner?.repository !== undefined) {
      if (!owned || !Number.isInteger(entry.owner.pid) || entry.owner.pid <= 0) continue;
      try {
        process.kill(entry.owner.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") temp.orphan_count++;
      }
    } else if (
      candidates.length === 0 &&
      existsSync(entry.path) &&
      lstatSync(entry.path).mtimeMs < Date.now() - 86400000
    ) {
      temp.orphan_count++;
    }
  }
  const directory = stateDir(repositoryRoot);
  const land = lastRecord(path.join(directory, "lands"));
  const gc = lastRecord(path.join(directory, "gc"));
  const suggestedActions = batches
    .filter((batch) => batch.state === "ready")
    .map((batch) => `land ${batch.ref} --target ${name}`);
  if (batches.some((batch) => batch.state === "landed") || temp.orphan_count)
    suggestedActions.push("panagent gc");
  for (const run of attention) if (run.state === "PAUSED") suggestedActions.push(`resume ${run.run_id}`);
  return {
    target: { branch: name, ref, tip, worktree, clean },
    batches,
    runs: { total: runs.length, by_outcome: byOutcome, attention },
    graph: gitText(repositoryRoot, [
      "log",
      "--graph",
      "--oneline",
      "--decorate",
      "--max-count",
      "30",
      ref,
      ...batches.map((batch) => batch.ref),
      "--",
    ]),
    last_land: land
      ? {
          created_at: land.created_at,
          commits: land.commits?.length ?? 0,
          retired: land.retired?.length ?? 0,
          kept: land.kept?.length ?? 0,
        }
      : null,
    last_gc: gc
      ? {
          created_at: gc.created_at,
          done: gc.done?.length ?? 0,
          skipped: gc.skipped?.length ?? 0,
          total_size: gc.total_size ?? 0,
        }
      : null,
    disk: { run_store_size: sizeOf(store.root), temp },
    suggested_actions: suggestedActions,
  };
}

/** @param {ReturnType<typeof repositoryStatus>} status */
export function formatStatusText(status) {
  const lines = [
    "Target",
    `  ${status.target.branch} ${status.target.tip} (worktree: ${status.target.clean === null ? "not checked out" : status.target.clean ? "clean" : "dirty"})`,
    "Batches",
    ...status.batches.map(
      (batch) =>
        `  ${batch.ref} ${batch.tip} ${batch.state} +${batch.ahead}/-${batch.behind} receipts=${batch.receipted ? "valid" : "invalid"}${batch.run ? ` run=${batch.run.run_id} (${batch.run.outcome ?? "unknown"})` : ""}`,
    ),
    "Runs",
    `  ${Object.entries(status.runs.by_outcome)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(" ")}`,
    ...status.runs.attention.map(
      (run) => `  ${run.state} ${run.run_id}${run.awaiting ? ` waiting: ${run.awaiting}` : ""}`,
    ),
    "Graph",
    status.graph,
    "Last records",
    `  land: ${status.last_land ? `${status.last_land.created_at} commits=${status.last_land.commits} retired=${status.last_land.retired} kept=${status.last_land.kept}` : "none"}`,
    `  gc: ${status.last_gc ? `${status.last_gc.created_at} done=${status.last_gc.done} skipped=${status.last_gc.skipped} bytes=${status.last_gc.total_size}` : "none"}`,
    "Disk",
    `  runs: ${status.disk.run_store_size} bytes; temp owned: ${status.disk.temp.owned.count} / ${status.disk.temp.owned.size} bytes; other: ${status.disk.temp.other.count} / ${status.disk.temp.other.size} bytes`,
    "Next actions",
    ...status.suggested_actions,
  ];
  return lines.join("\n");
}
