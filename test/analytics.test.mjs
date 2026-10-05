// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { collectRunFacts } from "../src/analytics/collect.mjs";
import { computeAnalytics, DEFINITIONS } from "../src/analytics/compute.mjs";
import { formatAnalyticsMarkdown, formatAnalyticsText } from "../src/analytics/report.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { makeRepo } from "./helpers.mjs";

/**
 * @param {RunStore} store
 * @param {number} index
 * @param {Record<string, unknown>} [meta]
 */
function addRun(store, index, meta = {}) {
  const id = `task-20260101T000000Z-${index.toString(16).padStart(4, "0")}`;
  store.create(id, {
    task_id: "feature-01",
    workflow: "code-delivery",
    created_at: "2026-01-01T00:00:00.000Z",
    ...meta,
  });
  return id;
}

/** @param {RunStore} store @param {string} id */
function sessions(store, id) {
  for (const [index, role] of ["implementer", "reviewer"].entries()) {
    const dir = store.sessionDir(id, index + 1);
    writeFileSync(path.join(dir, "session.json"), JSON.stringify({ role }));
    const trace =
      role === "implementer"
        ? [
            { tool: "read_files", ok: true },
            { tool: "read_files", ok: false },
            { tool: "run_check", ok: true, status: "pass" },
            { tool: "run_check", ok: true, status: "fail" },
            { tool: "run_check", ok: true, status: "infra_error" },
          ]
        : [{ tool: "read_files", ok: true }];
    writeFileSync(path.join(dir, "tools.jsonl"), trace.map((entry) => JSON.stringify(entry)).join("\n"));
  }
}

test("collects run metadata, event histories, stage totals and role tool traces", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    const id = addRun(store, 1);
    store.update(id, {
      outcome: "PASSED",
      finished_at: "2026-01-01T00:00:10.000Z",
      state: {
        counters: { repairs: 1 },
        invocations: 3,
        retries: 1,
        runtimes: { implementer: { adapter: "fake", model: "small" } },
        usage: { implementer: { input_tokens: 100, output_tokens: 20, cost_usd: 0.1 } },
      },
    });
    store.event(id, "stage.started", { stage: "agent", at: "2026-01-01T00:00:00Z" });
    store.event(id, "stage.completed", { stage: "agent", at: "2026-01-01T00:00:02Z" });
    store.event(id, "stage.started", { stage: "agent", at: "2026-01-01T00:00:03Z" });
    store.event(id, "stage.failed", { stage: "agent", at: "2026-01-01T00:00:04Z" });
    store.event(id, "stage.started", { stage: "pending", at: "2026-01-01T00:00:04Z" });
    store.event(id, "verification.started");
    store.event(id, "check.finished", { id: "test", status: "fail", duration_ms: 100 });
    store.event(id, "verification.started");
    store.event(id, "check.finished", { id: "test", status: "pass", duration_ms: 200 });
    store.event(id, "review.finished", { decision: "FIX", findings: 2 });
    store.event(id, "review.finished", { decision: "PASS", findings: 0 });
    sessions(store, id);
    const [fact] = collectRunFacts(repo.root);
    assert.deepEqual(fact, {
      run_id: id,
      workflow: "code-delivery",
      task_id: "feature-01",
      family: "feature",
      outcome: "PASSED",
      stale: false,
      error_class: null,
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:10.000Z",
      duration_ms: 10000,
      repairs: 1,
      agent_invocations: 3,
      retries: 1,
      runtimes: { implementer: { adapter: "fake", model: "small" } },
      usage: { implementer: { input_tokens: 100, output_tokens: 20, cost_usd: 0.1 } },
      checks: [
        { id: "test", status: "fail", duration_ms: 100, attempt: 0 },
        { id: "test", status: "pass", duration_ms: 200, attempt: 1 },
      ],
      review_decisions: ["FIX", "PASS"],
      review_findings: 2,
      stage_ms: { agent: 3000 },
      tools: {
        implementer: {
          calls: 5,
          errors: 1,
          by_tool: {
            read_files: { calls: 2, errors: 1 },
            run_check: { calls: 3, errors: 0 },
          },
          run_check: { calls: 3, pass: 1, fail: 1, infra_error: 1 },
        },
        reviewer: {
          calls: 1,
          errors: 0,
          by_tool: { read_files: { calls: 1, errors: 0 } },
          run_check: { calls: 0, pass: 0, fail: 0, infra_error: 0 },
        },
      },
    });
  } finally {
    repo.cleanup();
  }
});

test("filters inclusive dates and exact workflow, preserves stale runs and skips unreadable runs", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    const stale = addRun(store, 1, { pid: 2147483647 });
    const paused = addRun(store, 2, {
      created_at: "2026-01-02T23:59:59Z",
      workflow: "integration",
      outcome: "PAUSED",
      task_id: "plain",
    });
    store.event(paused, "run.started", { at: "2026-01-02T00:00:00Z" });
    store.event(paused, "run.paused", { at: "2026-01-02T00:00:03Z" });
    const broken = addRun(store, 3);
    writeFileSync(path.join(store.dir(broken), "run.json"), "{");
    const brokenEvents = addRun(store, 4);
    writeFileSync(path.join(store.dir(brokenEvents), "events.jsonl"), "{");
    assert.equal(collectRunFacts(repo.root).length, 2);
    const fact = collectRunFacts(repo.root, { since: "2026-01-01", until: "2026-01-01" })[0];
    assert.equal(fact.run_id, stale);
    assert.equal(fact.stale, true);
    assert.equal(fact.outcome, "STALE");
    const analytics = computeAnalytics([fact]);
    assert.deepEqual(analytics.outcomes.by_outcome, { STALE: 1 });
    assert.equal(analytics.tasks.tasks, 0);
    assert.equal(analytics.tasks.first_run_pass_rate, null);
    assert.equal(fact.duration_ms, null);
    const filtered = collectRunFacts(repo.root, {
      since: "2026-01-02",
      until: "2026-01-02",
      workflow: "integration",
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].duration_ms, 3000);
    assert.equal(filtered[0].family, "plain");
    assert.deepEqual(collectRunFacts(repo.root, { workflow: "integrat" }), []);
  } finally {
    repo.cleanup();
  }
});

test("computes every statistics section, earliest task runs, finished rates and nearest ranks", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    const outcomes = ["FAILED", "PASSED", "PASSED", "PASSED", "ERROR", "RUNNING", "PAUSED", "ESCALATED"];
    for (const [index, outcome] of outcomes.entries()) {
      const id = addRun(store, index + 1, {
        task_id: index < 2 ? "repeat-01" : `task-${index}`,
        workflow: index === 3 ? "integration" : "code-delivery",
        created_at: `2026-01-0${index + 1}T00:00:00Z`,
      });
      store.update(id, {
        outcome,
        finished_at: `2026-01-0${index + 1}T00:00:0${index + 1}Z`,
        repairs: index === 1 ? 1 : 0,
        error_class: index === 4 || index === 5 ? "infra" : null,
        state: {
          runtimes: {
            implementer: { adapter: "fake", model: "small" },
            reviewer: { adapter: "fake", model: "large" },
          },
          usage: { implementer: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01 } },
        },
      });
      store.event(id, "verification.started");
      store.event(id, "check.finished", {
        id: "test",
        status: index === 0 ? "fail" : index === 4 ? "infra_error" : "pass",
        duration_ms: (index + 1) * 100,
      });
      store.event(id, "review.finished", {
        decision: index === 0 ? "FIX" : "PASS",
        findings: index === 0 ? 2 : 0,
      });
      store.event(id, "stage.started", {
        stage: "checks",
        at: `2026-01-0${index + 1}T00:00:00Z`,
      });
      store.event(id, "stage.completed", {
        stage: "checks",
        at: `2026-01-0${index + 1}T00:00:01Z`,
      });
      sessions(store, id);
    }
    const result = computeAnalytics(collectRunFacts(repo.root));
    assert.deepEqual(result.window, {
      first_run: "2026-01-01T00:00:00Z",
      last_run: "2026-01-08T00:00:00Z",
      runs: 8,
    });
    assert.deepEqual(result.outcomes.by_outcome, {
      FAILED: 1,
      PASSED: 3,
      ERROR: 1,
      RUNNING: 1,
      PAUSED: 1,
      ESCALATED: 1,
    });
    assert.deepEqual(result.outcomes.by_error_class, { infra: 1 });
    assert.deepEqual(result.outcomes.by_workflow.integration, { PASSED: 1 });
    assert.deepEqual(result.tasks, {
      tasks: 4,
      delivered: 2,
      delivered_rate: 50,
      first_run_clean: 1,
      first_run_clean_rate: 25,
      first_run_pass: 1,
      first_run_pass_rate: 25,
      runs_per_delivered: 2.5,
    });
    assert.deepEqual(result.repairs, {
      distribution: { 0: 1, 1: 1, 2: 0 },
      no_repair_rate: 50,
      within_one_rate: 100,
    });
    assert.deepEqual(result.checks.test, {
      runs: 6,
      pass: 4,
      fail: 1,
      infra_error: 1,
      fail_rate: 16.7,
      median_ms: 300,
      p90_ms: 800,
    });
    assert.deepEqual(result.review, {
      reviews: 6,
      by_decision: { FIX: 1, PASS: 5 },
      fix_rate: 16.7,
      findings_per_fix: 2,
    });
    assert.deepEqual(
      result.runtimes.find((entry) => entry.role === "implementer"),
      {
        role: "implementer",
        adapter: "fake",
        model: "small",
        runs: 8,
        passed: 3,
        pass_rate: 50,
        median_ms: 4000,
        input_tokens: 80,
        output_tokens: 16,
        cost_usd: 0.08,
      },
    );
    assert.equal(result.runtimes.length, 2);
    assert.deepEqual(result.tools.implementer, {
      median_calls_per_run: 5,
      error_rate: 20,
      run_check_calls: 24,
      run_check_pass_rate: 33.3,
    });
    assert.deepEqual(result.tools.reviewer, {
      median_calls_per_run: 1,
      error_rate: 0,
      run_check_calls: 0,
      run_check_pass_rate: null,
    });
    assert.deepEqual(result.durations, {
      run_median_ms: 4000,
      run_p90_ms: 8000,
      stages: { checks: { median_ms: 1000 } },
    });
    assert.deepEqual(
      result.per_day,
      outcomes.map((outcome, index) => ({
        date: `2026-01-0${index + 1}`,
        runs: 1,
        passed: outcome === "PASSED" ? 1 : 0,
      })),
    );
  } finally {
    repo.cleanup();
  }
});

test("first task runs exclude unfinished runs and use creation order", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    for (const [index, outcome] of ["RUNNING", "PAUSED", "PASSED", "FAILED"].entries()) {
      addRun(store, index + 1, {
        outcome,
        created_at: `2026-01-0${index + 1}T00:00:00Z`,
      });
    }
    // The collector lists newest first; the earliest finished run passed.
    const result = computeAnalytics(collectRunFacts(repo.root));
    assert.equal(result.tasks.tasks, 1);
    assert.equal(result.tasks.first_run_pass_rate, 100);
    assert.equal(result.tasks.first_run_clean_rate, 100);
  } finally {
    repo.cleanup();
  }
});

test("findings per fix excludes PASS-only and unfinished reviews", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    const fix = addRun(store, 1, { outcome: "FAILED" });
    store.event(fix, "review.finished", { decision: "FIX", findings: 2 });
    store.event(fix, "review.finished", { decision: "FIX", findings: 4 });
    const pass = addRun(store, 2, { outcome: "PASSED" });
    store.event(pass, "review.finished", { decision: "PASS", findings: 10 });
    const running = addRun(store, 3);
    store.event(running, "review.finished", { decision: "FIX", findings: 20 });
    const result = computeAnalytics(collectRunFacts(repo.root));
    assert.equal(result.review.findings_per_fix, 3);
    assert.equal(result.review.fix_rate, 66.7);
  } finally {
    repo.cleanup();
  }
});

test("reports show rates, converted durations, runtime usage and all definitions", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    const id = addRun(store, 1, {
      outcome: "PASSED",
      finished_at: "2026-01-01T00:02:00Z",
      state: {
        runtimes: { implementer: { adapter: "fake", model: null } },
        usage: { implementer: { input_tokens: 100, output_tokens: 20 } },
      },
    });
    store.event(id, "check.finished", { id: "test", status: "fail", duration_ms: 2500 });
    store.event(id, "review.finished", { decision: "FIX", findings: 2 });
    sessions(store, id);
    const result = computeAnalytics(collectRunFacts(repo.root));
    const text = formatAnalyticsText(result);
    assert.match(text, /window: runs=1, first run=2026-01-01/);
    assert.match(text, /outcomes: group=All runs, counts=PASSED=1/);
    assert.match(text, /delivered rate=100%/);
    assert.match(text, /repairs: distribution=0=1, 1=0, 2=0/);
    assert.match(text, /checks: check=test, runs=1, fail rate=100%, median seconds=2.5/);
    assert.match(text, /decisions=FIX=1, fix rate=100%, findings per fix=2/);
    assert.match(
      text,
      /role=implementer, adapter=fake, model=n\/a, runs=1, pass rate=100%, median minutes=2, input tokens=100, output tokens=20/,
    );
    assert.match(text, /error rate=20%, run_check calls=3, run_check pass rate=33.3%/);
    assert.match(text, /run median seconds=120, run p90 seconds=120/);
    const md = formatAnalyticsMarkdown(result, { definitions: DEFINITIONS });
    assert.match(md, /## Checks\n\n\| Check \| Runs \| Fail rate \| Median seconds \|/);
    assert.match(md, /\| test \| 1 \| 100% \| 2.5 \|/);
    assert.match(md, /## Definitions/);
    for (const [key, definition] of Object.entries(DEFINITIONS))
      assert.ok(md.includes(`| ${key} | ${definition} |`));
    for (const report of [
      formatAnalyticsText(computeAnalytics([])),
      formatAnalyticsMarkdown(computeAnalytics([]), { definitions: DEFINITIONS }),
    ]) {
      assert.ok(report.includes("n/a"));
      assert.ok(!report.includes("null"));
      assert.ok(!report.includes("n/a%"));
    }
  } finally {
    repo.cleanup();
  }
});

test("empty input has null rates, empty groups and frozen definitions", () => {
  const result = computeAnalytics([]);
  assert.deepEqual(result.window, { first_run: null, last_run: null, runs: 0 });
  assert.deepEqual(result.outcomes, { by_outcome: {}, by_error_class: {}, by_workflow: {} });
  assert.deepEqual(result.tasks, {
    tasks: 0,
    delivered: 0,
    delivered_rate: null,
    first_run_clean: 0,
    first_run_clean_rate: null,
    first_run_pass: 0,
    first_run_pass_rate: null,
    runs_per_delivered: null,
  });
  assert.deepEqual(result.repairs, {
    distribution: { 0: 0, 1: 0, 2: 0 },
    no_repair_rate: null,
    within_one_rate: null,
  });
  assert.deepEqual(result.checks, {});
  assert.deepEqual(result.review, {
    reviews: 0,
    by_decision: {},
    fix_rate: null,
    findings_per_fix: null,
  });
  assert.deepEqual(result.runtimes, []);
  for (const role of ["implementer", "reviewer"]) {
    assert.deepEqual(result.tools[role], {
      median_calls_per_run: null,
      error_rate: null,
      run_check_calls: 0,
      run_check_pass_rate: null,
    });
  }
  assert.deepEqual(result.durations, { run_median_ms: null, run_p90_ms: null, stages: {} });
  assert.deepEqual(result.per_day, []);
  assert.equal(Object.isFrozen(DEFINITIONS), true);
  assert.ok(Object.values(DEFINITIONS).every((definition) => typeof definition === "string"));
});
