// @ts-check
import { git } from "../util/git.mjs";
import { RunStore } from "./runs.mjs";

/**
 * Operating metrics. Two views, kept separate on purpose:
 *
 * 1. Runs (from the run store): every run, including failed, escalated, and
 *    errored ones. This is the honest denominator.
 * 2. Deliveries (from receipts): only promoted work, with its repair counts.
 *
 * Reporting only the second view overstates the pass rate, because a run
 * that never passes leaves no receipt.
 */

export const DEFINITIONS = Object.freeze({
  run: "One invocation of `panagent run` or `integrate`, recorded whatever its outcome.",
  finished_run: "A run whose outcome is PASSED, FAILED, ESCALATED, or ERROR (not RUNNING or PAUSED).",
  first_attempt_pass_rate:
    "Finished task runs (code-delivery) that PASSED with zero repairs, divided by all finished task runs.",
  harness_error_rate:
    "Finished runs that ended as ERROR (infra, provider, or tool-protocol failures), divided by all finished runs.",
  delivery: "A promoted commit with a receipt, excluding integrations.",
  integration: "A receipt on a merge commit (two or more parents): a topic integrated onto a base.",
  delivery_repairs: "Repair rounds recorded in a delivery's receipt (0, 1, or 2).",
});

/** @param {number} part @param {number} whole */
const percent = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : null);

/**
 * @param {string} repositoryRoot
 * @param {{ notesRef: string, reachableFrom?: string }} options when `reachableFrom` is set,
 *   only receipts on commits reachable from that ref count (for example, what has landed on main)
 */
export function computeMetrics(repositoryRoot, options) {
  const runs = new RunStore(repositoryRoot).list();
  const finished = runs.filter((run) => ["PASSED", "FAILED", "ESCALATED", "ERROR"].includes(run.outcome));
  const tasks = finished.filter((run) => run.workflow === "code-delivery");
  const count = (list, key) => {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const item of list) counts[item[key] ?? "none"] = (counts[item[key] ?? "none"] ?? 0) + 1;
    return counts;
  };

  const notes = git(repositoryRoot, ["notes", `--ref=${options.notesRef}`, "list"], { allowFailure: true });
  const reachable = options.reachableFrom
    ? new Set(
        String(git(repositoryRoot, ["rev-list", options.reachableFrom]).stdout)
          .trim()
          .split("\n"),
      )
    : null;
  const allCommits =
    notes.status === 0
      ? String(notes.stdout)
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")[1])
      : [];
  const commits = reachable ? allCommits.filter((commit) => reachable.has(commit)) : allCommits;
  const repairs = { 0: 0, 1: 0, 2: 0 };
  let deliveries = 0;
  let integrations = 0;
  for (const commit of commits) {
    const shown = git(repositoryRoot, ["notes", `--ref=${options.notesRef}`, "show", commit], {
      allowFailure: true,
    });
    if (shown.status !== 0) continue;
    let receipt;
    try {
      receipt = JSON.parse(String(shown.stdout));
    } catch {
      continue;
    }
    const isIntegration =
      receipt.workflow === "integrate" || (Array.isArray(receipt.parents) && receipt.parents.length > 1);
    if (isIntegration) {
      integrations += 1;
      continue;
    }
    deliveries += 1;
    const used = receipt.repairs ?? receipt.repair_attempts ?? 0;
    repairs[used] = (repairs[used] ?? 0) + 1;
  }
  const dates = runs.map((run) => String(run.created_at)).sort();
  return {
    as_of: new Date().toISOString().slice(0, 10),
    runs: {
      total: runs.length,
      finished: finished.length,
      first_run: dates[0] ?? null,
      last_run: dates.at(-1) ?? null,
      by_outcome: count(runs, "outcome"),
      by_error_class: count(
        finished.filter((run) => run.error_class),
        "error_class",
      ),
      first_attempt_pass_rate: percent(
        tasks.filter((run) => run.outcome === "PASSED" && (run.repairs ?? 0) === 0).length,
        tasks.length,
      ),
      harness_error_rate: percent(finished.filter((run) => run.outcome === "ERROR").length, finished.length),
    },
    deliveries: {
      scope: options.reachableFrom
        ? `receipts on commits reachable from ${options.reachableFrom}`
        : `all receipts under ${options.notesRef}`,
      receipts: commits.length,
      deliveries,
      integrations,
      repairs,
      no_repair_rate: percent(repairs[0], deliveries),
      within_one_repair_rate: percent(repairs[0] + repairs[1], deliveries),
    },
    definitions: DEFINITIONS,
  };
}
