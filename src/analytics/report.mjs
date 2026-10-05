// @ts-check

/** @typedef {ReturnType<typeof import("./compute.mjs").computeAnalytics>} Analytics */
/** @typedef {string | number | null} Cell */

/** @param {Cell} value */
function display(value) {
  return value === null ? "n/a" : String(value);
}

/** @param {number | null} value */
function rate(value) {
  return value === null ? "n/a" : `${value}%`;
}

/** @param {number | null} value @param {number} divisor */
function duration(value, divisor) {
  return value === null ? "n/a" : String(Math.round((value / divisor) * 1000) / 1000);
}

/** @param {Record<string, number>} values */
function distribution(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ") || "none"
  );
}

/** @param {Analytics} analytics */
function sections(analytics) {
  const { window, outcomes, tasks, repairs, review, durations } = analytics;
  /** @type {{ title: string, headers: string[], rows: Cell[][] }[]} */
  const result = [
    {
      title: "Window",
      headers: ["Runs", "First run", "Last run"],
      rows: [[window.runs, window.first_run, window.last_run]],
    },
    {
      title: "Outcomes",
      headers: ["Group", "Counts"],
      rows: [
        ["All runs", distribution(outcomes.by_outcome)],
        ["Error class", distribution(outcomes.by_error_class)],
        ...Object.entries(outcomes.by_workflow).map(([workflow, counts]) => [workflow, distribution(counts)]),
      ],
    },
    {
      title: "Tasks",
      headers: [
        "Tasks",
        "Delivered",
        "Delivered rate",
        "First run clean rate",
        "First run pass rate",
        "Runs per delivered",
      ],
      rows: [
        [
          tasks.tasks,
          tasks.delivered,
          rate(tasks.delivered_rate),
          rate(tasks.first_run_clean_rate),
          rate(tasks.first_run_pass_rate),
          tasks.runs_per_delivered,
        ],
      ],
    },
    {
      title: "Repairs",
      headers: ["Distribution", "No repair rate", "Within one rate"],
      rows: [
        [distribution(repairs.distribution), rate(repairs.no_repair_rate), rate(repairs.within_one_rate)],
      ],
    },
    {
      title: "Checks",
      headers: ["Check", "Runs", "Fail rate", "Median seconds"],
      rows: Object.entries(analytics.checks).map(([id, check]) => [
        id,
        check.runs,
        rate(check.fail_rate),
        duration(check.median_ms, 1000),
      ]),
    },
    {
      title: "Review",
      headers: ["Reviews", "Decisions", "Fix rate", "Findings per fix"],
      rows: [
        [review.reviews, distribution(review.by_decision), rate(review.fix_rate), review.findings_per_fix],
      ],
    },
    {
      title: "Runtimes",
      headers: [
        "Role",
        "Adapter",
        "Model",
        "Runs",
        "Pass rate",
        "Median minutes",
        "Input tokens",
        "Output tokens",
      ],
      rows: analytics.runtimes.map((runtime) => [
        runtime.role,
        runtime.adapter,
        runtime.model,
        runtime.runs,
        rate(runtime.pass_rate),
        duration(runtime.median_ms, 60000),
        runtime.input_tokens,
        runtime.output_tokens,
      ]),
    },
    {
      title: "Tools",
      headers: ["Role", "Median calls per run", "Error rate", "run_check calls", "run_check pass rate"],
      rows: Object.entries(analytics.tools).map(([role, tools]) => [
        role,
        tools.median_calls_per_run,
        rate(tools.error_rate),
        tools.run_check_calls,
        rate(tools.run_check_pass_rate),
      ]),
    },
    {
      title: "Durations",
      headers: ["Run median seconds", "Run p90 seconds"],
      rows: [[duration(durations.run_median_ms, 1000), duration(durations.run_p90_ms, 1000)]],
    },
  ];
  return result;
}

/** @param {Analytics} analytics */
export function formatAnalyticsText(analytics) {
  return sections(analytics)
    .flatMap(({ title, headers, rows }) =>
      rows.length
        ? rows.map(
            (row) =>
              `${title.toLowerCase()}: ${row.map((cell, index) => `${headers[index].toLowerCase()}=${display(cell)}`).join(", ")}`,
          )
        : [`${title.toLowerCase()}: none`],
    )
    .join("\n");
}

/** @param {Cell} value */
function markdownCell(value) {
  return display(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * @param {Analytics} analytics
 * @param {{ definitions: Readonly<Record<string, string>> }} options
 */
export function formatAnalyticsMarkdown(analytics, { definitions }) {
  const reports = sections(analytics).map(({ title, headers, rows }) =>
    [
      `## ${title}`,
      "",
      `| ${headers.map(markdownCell).join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
    ].join("\n"),
  );
  reports.push(
    [
      "## Definitions",
      "",
      "| Metric | Definition |",
      "| --- | --- |",
      ...Object.entries(definitions).map(
        ([key, definition]) => `| ${markdownCell(key)} | ${markdownCell(definition)} |`,
      ),
    ].join("\n"),
  );
  return reports.join("\n\n");
}
