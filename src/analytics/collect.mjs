// @ts-check
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RunStore } from "../core/runs.mjs";

/**
 * @typedef {{ calls: number, errors: number, by_tool: Record<string, { calls: number, errors: number }>, run_check: { calls: number, pass: number, fail: number, infra_error: number } }} ToolFacts
 * @typedef {{
 * run_id: string, workflow: string, task_id: string, family: string, outcome: string,
 * stale: boolean, error_class: string | null, created_at: string, finished_at: string | null,
 * duration_ms: number | null, repairs: number, agent_invocations: number, retries: number,
 * runtimes: Record<string, { adapter: string, model?: string | null }>,
 * usage: Record<string, Record<string, number>>,
 * checks: { id: string, status: string, duration_ms: number | null, attempt: number }[],
 * review_decisions: string[], review_events: { decision: string, findings: number }[],
 * review_findings: number, stage_ms: Record<string, number>,
 * tools: Record<string, ToolFacts>
 * }} RunFact
 */

/** @returns {ToolFacts} */
function emptyTools() {
  return {
    calls: 0,
    errors: 0,
    by_tool: {},
    run_check: { calls: 0, pass: 0, fail: 0, infra_error: 0 },
  };
}

/** @param {string | null | undefined} start @param {string | null | undefined} end */
function elapsed(start, end) {
  const value = Date.parse(end ?? "") - Date.parse(start ?? "");
  return Number.isFinite(value) ? value : null;
}

/**
 * Read the repository's run store without modifying it.
 * @param {string} repositoryRoot
 * @param {{ since?: string, until?: string, workflow?: string }} [options]
 * @returns {RunFact[]}
 */
export function collectRunFacts(repositoryRoot, { since, until, workflow } = {}) {
  const store = new RunStore(repositoryRoot);
  /** @type {RunFact[]} */
  const facts = [];
  for (const run of store.list()) {
    if (run.unreadable) continue;
    const date = String(run.created_at).slice(0, 10);
    if (since && date < since) continue;
    if (until && date > until) continue;
    if (workflow !== undefined && run.workflow !== workflow) continue;
    try {
      const events = store.events(run.run_id);
      /** @type {RunFact["checks"]} */
      const checks = [];
      /** @type {string[]} */
      const decisions = [];
      /** @type {RunFact["review_events"]} */
      const reviews = [];
      /** @type {Record<string, number>} */
      const stages = {};
      /** @type {Map<string, string[]>} */
      const starts = new Map();
      let attempt = -1;
      let findings = 0;
      for (const event of events) {
        if (event.type === "verification.started") attempt += 1;
        if (event.type === "check.finished") {
          checks.push({
            id: event.id,
            status: event.status,
            duration_ms: event.duration_ms ?? null,
            attempt,
          });
        }
        if (event.type === "review.finished") {
          decisions.push(event.decision);
          const count = Array.isArray(event.findings) ? event.findings.length : (event.findings ?? 0);
          reviews.push({ decision: event.decision, findings: count });
          findings += count;
        }
        if (event.type === "stage.started") {
          const pending = starts.get(event.stage) ?? [];
          pending.push(event.at);
          starts.set(event.stage, pending);
        }
        if (event.type === "stage.completed" || event.type === "stage.failed") {
          const pending = starts.get(event.stage);
          if (pending?.length) {
            for (const start of pending) {
              const duration = elapsed(start, event.at);
              if (duration !== null) stages[event.stage] = (stages[event.stage] ?? 0) + duration;
            }
            starts.delete(event.stage);
          }
        }
      }
      const tools = run.archived_tools ?? { implementer: emptyTools(), reviewer: emptyTools() };
      const sessions = path.join(store.dir(run.run_id), "sessions");
      if (existsSync(sessions)) {
        for (const name of readdirSync(sessions).filter((entry) => /^\d{3}$/.test(entry))) {
          if (run.pruned_sessions?.includes(name)) continue;
          const dir = path.join(sessions, name);
          const session = JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8"));
          if (session.role !== "implementer" && session.role !== "reviewer") continue;
          const role = /** @type {"implementer" | "reviewer"} */ (session.role);
          const trace = path.join(dir, "tools.jsonl");
          if (!existsSync(trace)) continue;
          for (const line of readFileSync(trace, "utf8").split("\n").filter(Boolean)) {
            const entry = JSON.parse(line);
            const totals = tools[role];
            const byTool = (totals.by_tool[entry.tool] ??= { calls: 0, errors: 0 });
            totals.calls += 1;
            byTool.calls += 1;
            if (entry.ok === false) {
              totals.errors += 1;
              byTool.errors += 1;
            }
            if (entry.tool === "run_check") {
              totals.run_check.calls += 1;
              if (entry.status === "pass") totals.run_check.pass += 1;
              if (entry.status === "fail") totals.run_check.fail += 1;
              if (entry.status === "infra_error") totals.run_check.infra_error += 1;
            }
          }
        }
      }
      const state = run.state ?? {};
      facts.push({
        run_id: run.run_id,
        workflow: run.workflow,
        task_id: run.task_id,
        family: String(run.task_id).replace(/-\d{2}$/, ""),
        outcome: run.stale ? "STALE" : run.outcome,
        stale: run.stale ?? false,
        error_class: run.error_class ?? state.error?.error_class ?? null,
        created_at: run.created_at,
        finished_at: run.finished_at ?? null,
        duration_ms: elapsed(run.created_at, run.finished_at) ?? elapsed(events[0]?.at, events.at(-1)?.at),
        repairs: run.repairs ?? state.counters?.repairs ?? 0,
        agent_invocations: run.agent_invocations ?? state.invocations ?? 0,
        retries: run.retries ?? state.retries ?? 0,
        runtimes: state.runtimes ?? {},
        usage: state.usage ?? {},
        checks,
        review_decisions: decisions,
        review_events: reviews,
        review_findings: findings,
        stage_ms: stages,
        tools,
      });
    } catch {
      // A partially written or unreadable run cannot supply reliable facts.
    }
  }
  return facts;
}
