// @ts-check
import { roleProvider } from "../config/runtime.mjs";
import { TERMINAL } from "../core/runs.mjs";

/** @typedef {import("./collect.mjs").RunFact} RunFact */

/** @param {number} numerator @param {number} denominator */
function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

/** @param {(number | null)[]} values @param {number} rank */
function percentile(values, rank) {
  const sorted = values.filter((value) => value !== null && Number.isFinite(value));
  sorted.sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * rank) - 1] : null;
}

/** @param {string[]} values @returns {Record<string, number>} */
function counts(values) {
  const result = {};
  for (const value of values) {
    Object.defineProperty(result, value, {
      value: (Object.hasOwn(result, value) ? result[value] : 0) + 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * @template T
 * @param {T[]} values
 * @param {(value: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const name = key(value);
    const group = groups.get(name) ?? [];
    group.push(value);
    groups.set(name, group);
  }
  return groups;
}

/** @param {RunFact[]} facts */
export function computeAnalytics(facts) {
  const finished = facts.filter((fact) => TERMINAL.has(fact.outcome));
  const ordered = [...facts].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const taskRuns = finished.filter((fact) => fact.workflow === "code-delivery");
  const groups = groupBy(taskRuns, (fact) => fact.task_id);
  const first = [...groups.values()].map(
    (runs) => [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))[0],
  );
  const delivered = [...groups.values()].filter((runs) =>
    runs.some((run) => run.outcome === "PASSED"),
  ).length;
  const firstPass = first.filter((run) => run?.outcome === "PASSED").length;
  const firstClean = first.filter((run) => run.outcome === "PASSED" && run.repairs === 0).length;
  const passed = taskRuns.filter((run) => run.outcome === "PASSED");
  const distribution = { 0: 0, 1: 0, 2: 0 };
  for (const run of passed) distribution[run.repairs] = (distribution[run.repairs] ?? 0) + 1;
  const workflows = groupBy(facts, (fact) => fact.workflow);
  const checkGroups = groupBy(
    finished.flatMap((fact) => fact.checks),
    (check) => check.id,
  );
  const decisions = finished.flatMap((fact) => fact.review_decisions);
  const byDecision = counts(decisions);
  const fixReviews = finished
    .flatMap((fact) => fact.review_events)
    .filter((review) => review.decision === "FIX");
  /** @type {Map<string, { role: string, adapter: string, model: string | null, facts: RunFact[] }>} */
  const runtimeGroups = new Map();
  for (const fact of facts) {
    for (const [role, runtime] of Object.entries(fact.runtimes)) {
      if (!runtime) continue;
      const model = runtime.model ?? null;
      const key = JSON.stringify([role, runtime.adapter, model]);
      if (!runtimeGroups.has(key)) {
        runtimeGroups.set(key, { role, adapter: runtime.adapter, model, facts: [] });
      }
      runtimeGroups.get(key)?.facts.push(fact);
    }
  }
  /** @type {Record<string, { median_calls_per_run: number | null, error_rate: number | null, run_check_calls: number, run_check_pass_rate: number | null }>} */
  const tools = {};
  for (const role of ["implementer", "reviewer"]) {
    const recorded = facts.filter((fact) => fact.runtimes[role] || fact.tools[role]?.calls);
    const completed = recorded.filter((fact) => TERMINAL.has(fact.outcome));
    const totals = completed.map((fact) => fact.tools[role]);
    const calls = totals.reduce((sum, entry) => sum + (entry?.calls ?? 0), 0);
    const errors = totals.reduce((sum, entry) => sum + (entry?.errors ?? 0), 0);
    const checks = totals.reduce((sum, entry) => sum + (entry?.run_check.calls ?? 0), 0);
    const passes = totals.reduce((sum, entry) => sum + (entry?.run_check.pass ?? 0), 0);
    tools[role] = {
      median_calls_per_run: percentile(
        recorded.map((fact) => fact.tools[role]?.calls ?? 0),
        0.5,
      ),
      error_rate: percent(errors, calls),
      run_check_calls: facts.reduce((sum, fact) => sum + (fact.tools[role]?.run_check.calls ?? 0), 0),
      run_check_pass_rate: percent(passes, checks),
    };
  }
  const reviewIndependence = { independent: 0, same_provider: 0, unknown: 0 };
  for (const fact of facts) {
    const implementer = fact.runtimes.implementer;
    const reviewer = fact.runtimes.reviewer;
    const left = implementer ? roleProvider(implementer) : "unknown";
    const right = reviewer ? roleProvider(reviewer) : "unknown";
    if (left === "unknown" || right === "unknown") reviewIndependence.unknown += 1;
    else if (left === right) reviewIndependence.same_provider += 1;
    else reviewIndependence.independent += 1;
  }
  const stageNames = new Set(facts.flatMap((fact) => Object.keys(fact.stage_ms)));
  const days = groupBy(facts, (fact) => fact.created_at.slice(0, 10));
  return {
    window: {
      first_run: ordered[0]?.created_at ?? null,
      last_run: ordered.at(-1)?.created_at ?? null,
      runs: facts.length,
    },
    outcomes: {
      by_outcome: counts(facts.map((fact) => fact.outcome)),
      by_error_class: counts(finished.flatMap((fact) => (fact.error_class ? [fact.error_class] : []))),
      by_workflow: Object.fromEntries(
        [...workflows].map(([workflow, runs]) => [workflow, counts(runs.map((run) => run.outcome))]),
      ),
    },
    tasks: {
      tasks: groups.size,
      delivered,
      delivered_rate: percent(delivered, groups.size),
      first_run_clean: firstClean,
      first_run_clean_rate: percent(firstClean, groups.size),
      first_run_pass: firstPass,
      first_run_pass_rate: percent(firstPass, groups.size),
      runs_per_delivered: delivered ? taskRuns.length / delivered : null,
    },
    repairs: {
      distribution,
      no_repair_rate: percent(distribution[0], passed.length),
      within_one_rate: percent(distribution[0] + distribution[1], passed.length),
    },
    checks: Object.fromEntries(
      [...checkGroups].map(([id, checks]) => {
        const statuses = counts(checks.map((check) => check.status));
        const times = checks.map((check) => check.duration_ms);
        return [
          id,
          {
            runs: checks.length,
            pass: statuses.pass ?? 0,
            fail: statuses.fail ?? 0,
            infra_error: statuses.infra_error ?? 0,
            fail_rate: percent(statuses.fail ?? 0, checks.length),
            median_ms: percentile(times, 0.5),
            p90_ms: percentile(times, 0.9),
          },
        ];
      }),
    ),
    blocked: {
      runs: facts.filter((fact) => (fact.blocked?.reports ?? 0) > 0).length,
      reports: facts.reduce((sum, fact) => sum + (fact.blocked?.reports ?? 0), 0),
      confirmed: facts.reduce((sum, fact) => sum + (fact.blocked?.confirmed ?? 0), 0),
      rejected: facts.reduce((sum, fact) => sum + (fact.blocked?.rejected ?? 0), 0),
    },
    review_independence: reviewIndependence,
    review: {
      reviews: decisions.length,
      by_decision: byDecision,
      fix_rate: percent(byDecision.FIX ?? 0, decisions.length),
      findings_per_fix: fixReviews.length
        ? fixReviews.reduce((sum, review) => sum + review.findings, 0) / fixReviews.length
        : null,
    },
    runtimes: [...runtimeGroups.values()].map(({ role, adapter, model, facts: runs }) => {
      const completed = runs.filter((run) => TERMINAL.has(run.outcome));
      const passed = completed.filter((run) => run.outcome === "PASSED").length;
      const sum = (/** @type {string} */ key) =>
        runs.reduce((total, run) => total + (run.usage[role]?.[key] ?? 0), 0);
      return {
        role,
        adapter,
        model,
        runs: runs.length,
        passed,
        pass_rate: percent(passed, completed.length),
        median_ms: percentile(
          runs.map((run) => run.duration_ms),
          0.5,
        ),
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cost_usd: sum("cost_usd"),
      };
    }),
    tools,
    durations: {
      run_median_ms: percentile(
        facts.map((fact) => fact.duration_ms),
        0.5,
      ),
      run_p90_ms: percentile(
        facts.map((fact) => fact.duration_ms),
        0.9,
      ),
      stages: Object.fromEntries(
        [...stageNames].map((name) => [
          name,
          {
            median_ms: percentile(
              facts.map((fact) => fact.stage_ms[name] ?? null),
              0.5,
            ),
          },
        ]),
      ),
    },
    per_day: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, runs]) => ({
        date,
        runs: runs.length,
        passed: runs.filter((run) => run.outcome === "PASSED").length,
      })),
  };
}

export const DEFINITIONS = Object.freeze({
  window: "The window counts all runs and gives their earliest and latest creation timestamps.",
  outcomes: "Outcomes group all runs by outcome and workflow, and finished runs by recorded error class.",
  tasks: "Tasks group finished code-delivery runs by exact task ID in creation order.",
  delivered_rate: "Delivered tasks as a percentage of tasks with finished code-delivery runs.",
  first_run_clean_rate:
    "Tasks whose earliest finished code-delivery run passed without repairs as a percentage of tasks.",
  first_run_pass_rate: "Tasks whose earliest finished code-delivery run passed as a percentage of tasks.",
  runs_per_delivered: "Finished code-delivery runs divided by delivered tasks.",
  repairs: "Repair counts group passed code-delivery runs by their number of repair rounds.",
  no_repair_rate: "Passed code-delivery runs with no repairs as a percentage of passed code-delivery runs.",
  within_one_rate:
    "Passed code-delivery runs with at most one repair as a percentage of passed code-delivery runs.",
  checks: "Check executions in finished runs group by check ID, with nearest-rank duration percentiles.",
  fail_rate: "Failed check executions as a percentage of check executions in finished runs.",
  blocked:
    "Blocked runs and reports count implementer.blocked events; confirmations and rejections count reviewer claim decisions.",
  review: "Review decisions and findings count review events in finished runs.",
  review_independence:
    "All runs count as independent or same-provider using recorded role runtimes; missing providers count as unknown.",
  fix_rate: "FIX decisions as a percentage of review decisions in finished runs.",
  findings_per_fix:
    "Findings on FIX review events in finished runs divided by the number of those FIX review events.",
  runtimes: "Runs with recorded runtimes group by role, adapter, and model, summing role usage.",
  pass_rate: "Passed runs as a percentage of finished runs in each runtime group.",
  tools: "Tool calls group by session role, with nearest-rank medians over runs recording that role.",
  error_rate: "Tool errors as a percentage of tool calls in finished runs for each role.",
  run_check_pass_rate: "Passing run_check calls as a percentage of all run_check calls in finished runs.",
  durations: "Run and accumulated stage durations use nearest-rank median and p90 over available values.",
  per_day: "All runs group by UTC creation date with counts of runs and passed outcomes.",
});
