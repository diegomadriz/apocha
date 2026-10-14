// @ts-check
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkApochaDependencies } from "../adapters/dependencies.mjs";
import { adapterForRole } from "../adapters/index.mjs";
import { collectRunFacts } from "../analytics/collect.mjs";
import { computeAnalytics, DEFINITIONS } from "../analytics/compute.mjs";
import { formatAnalyticsMarkdown, formatAnalyticsText } from "../analytics/report.mjs";
import {
  canRunTestPath,
  loadProjectConfig,
  loadProjectConfigAt,
  PROJECT_CONFIG_FILE,
} from "../config/project.mjs";
import { loadRuntimeConfig, roleProvider } from "../config/runtime.mjs";
import { validateTask } from "../config/task.mjs";
import { applyGc, planGc } from "../core/gc.mjs";
import { withLock } from "../core/lock.mjs";
import { computeMetrics } from "../core/metrics.mjs";
import { resumeRun, startRun } from "../core/run.mjs";
import { RunStore, stateDir } from "../core/runs.mjs";
import { formatStatusText, repositoryStatus } from "../core/status.mjs";
import { landBranch } from "../git/land.mjs";
import { verifyReceipt } from "../git/receipts.mjs";
import { allowedSignersAt, signingKeyAllowed } from "../git/signatures.mjs";
import { existingTestFiles } from "../git/test-edits.mjs";
import { testImpact } from "../git/test-impact.mjs";
import { formatRangeMarkdown, verifyRange } from "../git/verify-range.mjs";
import { detectBackend, resolveBackend } from "../sandbox/index.mjs";
import { describeError, HarnessError } from "../util/errors.mjs";
import { repositoryRoot, resolveCommit } from "../util/git.mjs";
import { inAnyScope } from "../util/paths.mjs";
import { loadSchema } from "../util/schema.mjs";
import { GENERATOR } from "../version.mjs";
import { initProject } from "./init.mjs";
import { liveProbe, sourceSecretsProbe } from "./probe.mjs";

export const EXIT = Object.freeze({ ok: 0, usage: 2, paused: 10, notPassed: 20, error: 30 });

const HELP = `apocha ${GENERATOR.version}: a deterministic controller for coding agents

Usage: apocha <command> [options]

Commands:
  init                          Write a starter apocha.config.json for this repository
  doctor [--live]               Check git, config, runtimes, and the sandbox (--live probes each runtime's lock-down)
  validate [--impact] <task.json> [--base <ref>] [--json]   Validate a task; list tests at risk
  run <task.json>               Run the code-delivery workflow
      --base <ref> --batch <name> (--message <text|@file> | --message-file <path>)
      [--runtimes <file>] [--allow-governance-edits --reason <text>] [--json] [--quiet]
  integrate <topic>             Merge a topic onto a base, verify, review, and promote
      --onto <ref> --batch <name> [--message <text|@file> | --message-file <path>] [--checks a,b] [--max-repairs 0|1|2]
      [--test-edits <policy>]       additive (default), new-files, allowed; reviewer sees every changed existing test
  land <source> --target <branch> [--keep-batch] [--require-signed]   Fast-forward a branch whose commits all carry valid receipts (never pushes)
  gc [--apply] [--keep-days N] [--abandon-paused-days N] [--target <branch>] [--json]
                                Plan cleanup (dry-run by default)
  status [run-id] [--target <branch>] [--json]   Show repository or run state
  verify-range <base>..<head> [--require-signed] [--json]   Verify PR receipts using base configuration
  receipt <commit>              Verify and print a receipt
  runs [--json]                 List runs, newest first
  show <run-id> [--events]      Show one run
  resume <run-id> [--decision approve|reject]   Resume a paused run
  metrics [--ref <ref>] [--json]  Outcomes over all runs, and delivery stats from receipts
  analytics [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--workflow <id>]
      [--json] [--format text|md]  Analytics over recorded runs in this repository
  version                       Print the version

Message options (run, integrate): --message and --message-file are mutually exclusive.
Use --message @file to read a file, or --message @@text for a literal leading @.

Runtime options (run, integrate, resume, doctor): --runtimes <file> --trust-repo-runtimes

Exit codes: 0 passed, 2 usage or config error, 10 paused, 20 not passed, 30 error.
Docs: docs/ in the package, starting with docs/architecture.md.
`;

/** @param {string} value */
function textOrFile(value) {
  if (value.startsWith("@@")) return value.slice(1);
  if (typeof value === "string" && value.startsWith("@") && value.length > 1)
    return readFileSync(path.resolve(value.slice(1)), "utf8");
  return value;
}

/**
 * @param {Record<string, any>} values
 * @param {string} fallback
 */
function commitMessage(values, fallback) {
  if (values.message !== undefined && values["message-file"] !== undefined)
    throw new HarnessError("config", "usage", "--message and --message-file are mutually exclusive");
  if (values["message-file"] !== undefined) return readFileSync(path.resolve(values["message-file"]), "utf8");
  return values.message !== undefined ? textOrFile(values.message) : fallback;
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

/** Progress lines on stderr. @param {boolean} quiet */
function progress(quiet) {
  return (/** @type {Record<string, any>} */ event) => {
    if (event.type === "test-policy.fallback") {
      process.stderr.write(
        'warning: tests.run_files is not set, so changes to existing tests are limited to additions; set tests.run_files, or give the task test_edits "allowed" with test_changes declarations\n',
      );
      return;
    }
    if (event.type === "sandbox.warning") {
      process.stderr.write(`warning: ${event.message}\n`);
      return;
    }
    if (quiet) return;
    const interesting = {
      "run.started": () => `run started: ${event.workflow} ${event.task_id} (sandbox: ${event.sandbox})`,
      "stage.started": () => `-> ${event.stage}`,
      "agent.finished": () =>
        `   ${event.role} #${event.invocation}: ${event.tool_calls} tool calls, ${event.submitted ? "submitted" : "no result"}${event.error ? `, ${event.error.error_class}/${event.error.code}` : ""}`,
      "agent.retry": () => `   retrying ${event.role} (${event.reason?.code ?? "transient"})`,
      "check.finished": () =>
        `   check ${event.id}: ${event.status}${event.error ? ` (${event.error})` : ""}`,
      "verification.finished": () => `   verification: ${event.status}`,
      "review.finished": () =>
        `   review: ${event.decision}${event.findings ? ` (${event.findings} findings)` : ""}`,
      "budget.spent": () => `   repair ${event.used}/${event.limit}`,
      "promotion.finished": () =>
        `   promoted ${String(event.promoted_head).slice(0, 12)} onto ${event.batch_ref}`,
      "run.paused": () => `run paused: ${event.reason ?? event.awaiting}`,
    }[event.type];
    if (interesting) process.stderr.write(`${interesting()}\n`);
  };
}

/** @param {{ outcome: string }} summary */
function exitFor(summary) {
  if (summary.outcome === "PASSED") return EXIT.ok;
  if (summary.outcome === "PAUSED") return EXIT.paused;
  if (summary.outcome === "ERROR") return EXIT.error;
  return EXIT.notPassed;
}

/**
 * @param {(signal: AbortSignal) => Promise<number>} command
 */
async function withRunSignals(command) {
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    if (!exitCode) exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    if (!exitCode) exitCode = 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const result = await command(controller.signal);
    return exitCode || result;
  } catch (error) {
    if (exitCode) return exitCode;
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/** @param {Record<string, any>} summary */
function formatSummary(summary) {
  const lines = [`${summary.outcome}  ${summary.task_id}  (run ${summary.run_id})`];
  if (summary.reason) lines.push(`reason: ${summary.reason}`);
  if (summary.promoted_head) lines.push(`promoted: ${summary.promoted_head} on ${summary.batch_ref}`);
  lines.push(
    `repairs: ${summary.repairs}, agent invocations: ${summary.agent_invocations}, retries: ${summary.retries}`,
  );
  if (summary.checks?.length)
    lines.push(`checks: ${summary.checks.map((check) => `${check.id}=${check.status}`).join(", ")}`);
  if (summary.review)
    lines.push(
      `review: ${summary.review.decision}${summary.review.findings?.length ? ` (${summary.review.findings.length} findings)` : ""}`,
    );
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  /** @type {(options: Record<string, any>, allowPositionals?: boolean) => { values: Record<string, any>, positionals: string[] }} */
  const parse = (options, allowPositionals = true) =>
    parseArgs({
      args: rest,
      options: { json: { type: "boolean" }, quiet: { type: "boolean" }, ...options },
      allowPositionals,
      strict: true,
    });

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return EXIT.ok;
    case "version":
    case "--version":
      print(GENERATOR.version);
      return EXIT.ok;
    case "init": {
      const { values } = parse({ force: { type: "boolean" } }, false);
      print(initProject(repositoryRoot(cwd), { force: Boolean(values.force) }));
      return EXIT.ok;
    }
    case "doctor": {
      const { values } = parse(
        {
          live: { type: "boolean" },
          runtimes: { type: "string" },
          "trust-repo-runtimes": { type: "boolean" },
        },
        false,
      );
      return doctor(cwd, {
        live: Boolean(values.live),
        runtimesPath: values.runtimes,
        trustRepoRuntimes: Boolean(values["trust-repo-runtimes"]),
        json: Boolean(values.json),
      });
    }
    case "validate": {
      const { values, positionals } = parse({
        impact: { type: "boolean" },
        base: { type: "string" },
      });
      if (positionals.length !== 1)
        throw new HarnessError("config", "usage", "validate needs exactly one task manifest");
      const root = repositoryRoot(cwd);
      const baseCommit = resolveCommit(root, values.base ?? "HEAD");
      if (!baseCommit)
        throw new HarnessError("config", "unknown_base", "validate base does not resolve to a commit");
      const config = loadProjectConfigAt(root, baseCommit);
      const task = validateTask(
        JSON.parse(readFileSync(path.resolve(positionals[0]), "utf8")),
        config,
        baseCommit,
      );
      if (config.tests.run_files?.paths !== undefined) {
        const outside = existingTestFiles({ root, base_commit: baseCommit }, config).filter(
          (file) => inAnyScope(file, task.allowed_paths) && !canRunTestPath(config, file),
        );
        for (const file of outside)
          process.stderr.write(
            `${file} is outside tests.run_files.paths; only additions will be accepted under justified\n`,
          );
      }
      if (values.impact) {
        const impact = testImpact(root, baseCommit, config, task);
        print(
          values.json
            ? { task, base_commit: baseCommit, impact }
            : [
                "Task valid. Tests at risk:",
                ...impact.map(
                  (entry) =>
                    `  ${entry.path} (${entry.declared ? "declared" : "undeclared"}): ${entry.chain.join(" -> ")}`,
                ),
              ].join("\n"),
        );
      } else print(task);
      return EXIT.ok;
    }
    case "run": {
      const { values, positionals } = parse({
        base: { type: "string" },
        batch: { type: "string" },
        message: { type: "string" },
        "message-file": { type: "string" },
        runtimes: { type: "string" },
        "trust-repo-runtimes": { type: "boolean" },
        "allow-governance-edits": { type: "boolean" },
        reason: { type: "string" },
      });
      const message = commitMessage(values, "");
      if (positionals.length !== 1 || !values.base || !values.batch || !message) {
        throw new HarnessError(
          "config",
          "usage",
          "run needs <task.json> --base <ref> --batch <name> (--message <text|@file> | --message-file <path>)",
        );
      }
      return withRunSignals(async (signal) => {
        const summary = await startRun({
          cwd,
          workflow: "code-delivery",
          task: JSON.parse(readFileSync(path.resolve(positionals[0]), "utf8")),
          base: values.base,
          batch: values.batch,
          message,
          runtimesPath: values.runtimes,
          trustRepoRuntimes: Boolean(values["trust-repo-runtimes"]),
          allowGovernanceEdits: Boolean(values["allow-governance-edits"]),
          governanceReason: values.reason,
          signal,
          onEvent: progress(Boolean(values.quiet || values.json)),
        });
        print(values.json ? summary : formatSummary(summary));
        return exitFor(summary);
      });
    }
    case "integrate": {
      const { values, positionals } = parse({
        onto: { type: "string" },
        batch: { type: "string" },
        message: { type: "string" },
        "message-file": { type: "string" },
        checks: { type: "string" },
        "max-repairs": { type: "string" },
        "test-edits": { type: "string" },
        runtimes: { type: "string" },
        "trust-repo-runtimes": { type: "boolean" },
        "allow-governance-edits": { type: "boolean" },
        reason: { type: "string" },
      });
      if (positionals.length !== 1 || !values.onto || !values.batch)
        throw new HarnessError("config", "usage", "integrate needs <topic> --onto <ref> --batch <name>");
      const message = commitMessage(values, `Integrate ${positionals[0]} into ${values.onto}`);
      const maxRepairs = values["max-repairs"] === undefined ? undefined : Number(values["max-repairs"]);
      if (maxRepairs !== undefined && ![0, 1, 2].includes(maxRepairs))
        throw new HarnessError("config", "usage", "--max-repairs must be 0, 1, or 2");
      const testEdits = values["test-edits"];
      const testEditPolicies = loadSchema("task.schema.json").properties.test_edits.enum.filter(
        (policy) => policy !== "justified",
      );
      if (testEdits !== undefined && !testEditPolicies.includes(testEdits))
        throw new HarnessError(
          "config",
          "usage",
          `--test-edits must be one of ${testEditPolicies.join(", ")}`,
        );
      return withRunSignals(async (signal) => {
        const summary = await startRun({
          cwd,
          workflow: "integrate",
          base: values.onto,
          batch: values.batch,
          message,
          runtimesPath: values.runtimes,
          trustRepoRuntimes: Boolean(values["trust-repo-runtimes"]),
          allowGovernanceEdits: Boolean(values["allow-governance-edits"]),
          governanceReason: values.reason,
          integration: {
            topic: positionals[0],
            checks: values.checks ? values.checks.split(",").filter(Boolean) : null,
            maxRepairs,
            testEdits,
          },
          signal,
          onEvent: progress(Boolean(values.quiet || values.json)),
        });
        print(values.json ? summary : formatSummary(summary));
        return exitFor(summary);
      });
    }
    case "land": {
      const { values, positionals } = parse({
        target: { type: "string" },
        "keep-batch": { type: "boolean" },
        "require-signed": { type: "boolean" },
      });
      if (positionals.length !== 1 || !values.target)
        throw new HarnessError("config", "usage", "land needs <source> --target <branch>");
      const root = repositoryRoot(cwd);
      // The target branch's own config names the notes ref its receipts live under.
      const targetCommit = resolveCommit(root, `refs/heads/${values.target}`);
      if (!targetCommit)
        throw new HarnessError("config", "unknown_target", `target branch does not exist: ${values.target}`);
      const config = loadProjectConfigAt(root, targetCommit);
      const result = await withLock(stateDir(root), `land ${values.target}`, () =>
        landBranch({
          repositoryRoot: root,
          notesRef: config.refs.notes,
          batchPrefix: config.refs.batch_prefix,
          keepBatch: Boolean(values["keep-batch"]),
          requireSigned: Boolean(values["require-signed"]),
          source: positionals[0],
          target: /** @type {string} */ (values.target),
        }),
      );
      print(
        values.json
          ? result
          : `landed ${result.commits.length} commit(s) on ${result.target}: ${result.old_head.slice(0, 12)} -> ${result.new_head.slice(0, 12)}`,
      );
      if (!values.json) {
        for (const entry of result.retired) print(`retired ${entry.ref} ${entry.oid}`);
        for (const entry of result.kept) print(`kept ${entry.ref} ${entry.oid}: ${entry.reason}`);
        print(`land record: ${result.record}`);
      }
      return EXIT.ok;
    }
    case "gc": {
      const { values } = parse(
        {
          apply: { type: "boolean" },
          "keep-days": { type: "string" },
          "abandon-paused-days": { type: "string" },
          target: { type: "string" },
        },
        false,
      );
      const root = repositoryRoot(cwd);
      const plan = planGc(root, {
        target: values.target,
        keepDays: values["keep-days"] === undefined ? undefined : Number(values["keep-days"]),
        abandonPausedDays:
          values["abandon-paused-days"] === undefined ? undefined : Number(values["abandon-paused-days"]),
      });
      const result = values.apply ? await applyGc(root, plan) : null;
      if (values.json) print(result ?? plan);
      else {
        const items = result?.done ?? plan.items;
        print(result ? "gc applied" : "gc plan (dry run)");
        for (const kind of ["abandon", "ref", "temp", "session", "worktree"]) {
          const group = items.filter((item) => item.kind === kind);
          print(
            `${kind}: ${group.length} item(s), ${group.reduce((sum, item) => sum + (item.size ?? 0), 0)} bytes`,
          );
          for (const item of group)
            print(
              `  ${item.path ?? item.ref ?? "git worktree prune"}${item.oid ? ` ${item.oid}` : ""}: ${item.reason}`,
            );
        }
        print(`total: ${items.length} item(s), ${result?.total_size ?? plan.total_size} bytes`);
        if (result) {
          for (const item of result.skipped)
            print(`skipped ${item.path ?? item.ref ?? item.kind}: ${item.reason}`);
          print(`gc record: ${result.record}`);
        }
      }
      return EXIT.ok;
    }
    case "status": {
      const { values, positionals } = parse({ target: { type: "string" } });
      if (positionals.length > 1) throw new HarnessError("config", "usage", "status accepts one run ID");
      if (positionals.length) {
        const store = new RunStore(repositoryRoot(cwd));
        const run = store.read(positionals[0]);
        print(
          values.json
            ? { ...run, candidate_patch: run.candidate_patch ?? null }
            : `${run.outcome} ${run.run_id}${run.reason ? `\nreason: ${run.reason}` : ""}${run.candidate_patch ? `\ncandidate patch: ${path.join(store.dir(run.run_id), run.candidate_patch.path)}` : ""}`,
        );
        return EXIT.ok;
      }
      const status = repositoryStatus(repositoryRoot(cwd), { target: values.target });
      print(values.json ? status : formatStatusText(status));
      return EXIT.ok;
    }
    case "verify-range": {
      const { values, positionals } = parse({ "require-signed": { type: "boolean" } });
      const range = positionals[0]?.match(/^([^.].*?)\.\.([^.].*)$/);
      if (positionals.length !== 1 || !range || range[1].includes("..") || range[2].includes(".."))
        throw new HarnessError("config", "usage", "verify-range needs <base>..<head>");
      const result = verifyRange({
        repositoryRoot: repositoryRoot(cwd),
        base: range[1],
        head: range[2],
        requireSigned: Boolean(values["require-signed"]),
      });
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatRangeMarkdown(result));
      if (values.json) print(result);
      else {
        for (const check of result.commits)
          print(
            `${check.commit} ${check.valid ? "valid" : check.reason} (signature: ${check.signature.status})`,
          );
        print(result.valid ? "All commits valid." : `First failing commit: ${result.first_failing_commit}`);
      }
      return result.valid ? EXIT.ok : EXIT.notPassed;
    }
    case "receipt": {
      const { values, positionals } = parse({ notes: { type: "string" } });
      if (positionals.length !== 1)
        throw new HarnessError("config", "usage", "receipt needs exactly one commit");
      const root = repositoryRoot(cwd);
      const config = loadProjectConfig(root);
      const notesRef = values.notes ?? config.refs.notes;
      const commit = resolveCommit(root, positionals[0]);
      if (!commit) throw new HarnessError("config", "unknown_commit", `not a commit: ${positionals[0]}`);
      const result = verifyReceipt(root, notesRef, commit, "HEAD", config.receipts.allowed_signers);
      print(result);
      return result.valid ? EXIT.ok : EXIT.notPassed;
    }
    case "runs": {
      const { values } = parse({}, false);
      const list = new RunStore(repositoryRoot(cwd)).list();
      if (values.json) print(list.map(({ state: _state, task: _task, ...run }) => run));
      else
        for (const run of list)
          print(
            `${(run.stale ? "STALE" : run.outcome).padEnd(9)} ${run.run_id}  ${run.workflow}  ${run.reason ?? ""}`.trimEnd(),
          );
      return EXIT.ok;
    }
    case "show": {
      const { values, positionals } = parse({ events: { type: "boolean" } });
      if (positionals.length !== 1) throw new HarnessError("config", "usage", "show needs a run id");
      const store = new RunStore(repositoryRoot(cwd));
      print(values.events ? store.events(positionals[0]) : store.read(positionals[0]));
      return EXIT.ok;
    }
    case "resume": {
      const { values, positionals } = parse({
        decision: { type: "string" },
        runtimes: { type: "string" },
        "trust-repo-runtimes": { type: "boolean" },
      });
      if (positionals.length !== 1) throw new HarnessError("config", "usage", "resume needs a run id");
      if (values.decision && !["approve", "reject"].includes(values.decision))
        throw new HarnessError("config", "usage", "--decision must be approve or reject");
      return withRunSignals(async (signal) => {
        const summary = await resumeRun({
          cwd,
          runId: positionals[0],
          decision: /** @type {any} */ (values.decision),
          runtimesPath: values.runtimes,
          trustRepoRuntimes: Boolean(values["trust-repo-runtimes"]),
          signal,
          onEvent: progress(Boolean(values.quiet || values.json)),
        });
        print(values.json ? summary : formatSummary(summary));
        return exitFor(summary);
      });
    }
    case "analytics": {
      const { values } = parse(
        {
          since: { type: "string" },
          until: { type: "string" },
          workflow: { type: "string" },
          format: { type: "string" },
        },
        false,
      );
      for (const option of ["since", "until"]) {
        const value = values[option];
        if (value === undefined) continue;
        const timestamp = Date.parse(value);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(timestamp) ||
          new Date(timestamp).toISOString().slice(0, 10) !== value
        )
          throw new HarnessError("config", "usage", `usage: --${option} must be a valid YYYY-MM-DD date`);
      }
      if (values.format !== undefined && !["text", "md"].includes(values.format))
        throw new HarnessError("config", "usage", "usage: --format must be text or md");
      const analytics = computeAnalytics(
        collectRunFacts(repositoryRoot(cwd), {
          since: values.since,
          until: values.until,
          workflow: values.workflow,
        }),
      );
      print(
        values.json
          ? { ...analytics, definitions: DEFINITIONS }
          : values.format === "md"
            ? formatAnalyticsMarkdown(analytics, { definitions: DEFINITIONS })
            : formatAnalyticsText(analytics),
      );
      return EXIT.ok;
    }
    case "metrics": {
      const { values } = parse({ notes: { type: "string" }, ref: { type: "string" } }, false);
      const root = repositoryRoot(cwd);
      const notesRef = values.notes ?? loadProjectConfig(root).refs.notes;
      const metrics = computeMetrics(root, { notesRef, reachableFrom: values.ref });
      if (values.json) print(metrics);
      else {
        const r = metrics.runs;
        const d = metrics.deliveries;
        print(
          [
            `runs: ${r.total} (${r.finished} finished) ${r.first_run ? `from ${r.first_run.slice(0, 10)} to ${r.last_run.slice(0, 10)}` : ""}`,
            `  by outcome: ${
              Object.entries(r.by_outcome)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ") || "none"
            }`,
            `  first-attempt pass rate: ${r.first_attempt_pass_rate ?? "n/a"}%   harness error rate: ${r.harness_error_rate ?? "n/a"}%`,
            `deliveries (receipts): ${d.deliveries}, integrations: ${d.integrations}`,
            `  repairs: 0=${d.repairs[0] ?? 0} 1=${d.repairs[1] ?? 0} 2=${d.repairs[2] ?? 0}   no repair: ${d.no_repair_rate ?? "n/a"}%   within one: ${d.within_one_repair_rate ?? "n/a"}%`,
            "Definitions: apocha metrics --json",
          ].join("\n"),
        );
      }
      return EXIT.ok;
    }
    default:
      throw new HarnessError("config", "usage", `unknown command: ${command}\n\n${HELP}`);
  }
}

/**
 * @param {string} cwd
 * @param {{ live: boolean, runtimesPath?: string, trustRepoRuntimes?: boolean, json: boolean, resolveDependency?: (specifier: string) => string }} options
 */
export async function doctor(cwd, options) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  const dependencies = checkApochaDependencies(options.resolveDependency);
  record("apocha dependencies", dependencies.ok, dependencies.detail);
  let root = null;
  try {
    root = repositoryRoot(cwd);
    record("git repository", true, root);
  } catch (error) {
    record("git repository", false, describeError(error).message);
  }
  if (root) {
    try {
      const secrets = sourceSecretsProbe(root);
      record("source secret files", secrets.ok, secrets.detail);
    } catch (error) {
      record("source secret files", false, describeError(error).message);
    }
  }
  let config = null;
  if (root) {
    try {
      config = loadProjectConfig(root);
      record(
        PROJECT_CONFIG_FILE,
        true,
        `${Object.keys(config.checks).length} checks, digest ${config.digest.slice(0, 12)}`,
      );
    } catch (error) {
      record(PROJECT_CONFIG_FILE, false, describeError(error).message);
    }
  }
  if (process.platform === "linux") {
    const version = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
    const reported = version.stdout?.trim() || "unavailable";
    const match = /(?:^|\s)(\d+)\.(\d+)(?:\.|$)/.exec(reported);
    const older = match && Number(match[1]) === 0 && Number(match[2]) < 12;
    record(
      "bubblewrap version",
      true,
      `${reported}${older ? "; warning: older than 0.12; mount points through symlinks are avoided by canonicalising paths" : ""}`,
    );
  }
  const detected = detectBackend();
  record(
    "sandbox backend",
    Boolean(detected) || config?.sandbox.mode === "none",
    detected ?? "none available (checks run without an OS sandbox)",
  );
  if (config) {
    if (!config.tests.run_files)
      record(
        "test edit policy",
        true,
        'warning: existing-test changes are limited to additions under the default justified policy until tests.run_files is set; example: "tests": {"run_files": {"run": ["node", "--test", "{files}"], "cwd": ".", "timeout_ms": 300000, "dependencies": "npm"}}',
      );
    record(
      "unsandboxed checks",
      true,
      Object.values(config.checks)
        .filter((check) => check.unsandboxed)
        .map((check) => check.id)
        .join(", ") || "none",
    );
    record(
      "browser checks",
      true,
      Object.values(config.checks)
        .filter((check) => check.browser)
        .map((check) => `${check.id} (Seatbelt allows org.chromium Mach services)`)
        .join(", ") || "none",
    );
    try {
      record(
        "sandbox for this project",
        true,
        `${config.sandbox.mode} -> ${resolveBackend(config.sandbox.mode)}`,
      );
    } catch (error) {
      record("sandbox for this project", false, describeError(error).message);
    }
  }
  if (root) {
    try {
      const runtimes = loadRuntimeConfig(root, options.runtimesPath, options.trustRepoRuntimes);
      record("runtime config", true, runtimes.source);
      record(
        "receipt signing",
        true,
        runtimes.signing ? `configured: ${runtimes.signing.principal}` : "no signing key configured",
      );
      record("signed receipts required", true, config?.receipts.require_signed ? "yes" : "no");
      if (runtimes.signing && config) {
        const allowed = signingKeyAllowed(
          runtimes.signing,
          allowedSignersAt(root, "HEAD", config.receipts.allowed_signers),
        );
        record(
          "signing key allowed",
          allowed,
          allowed
            ? "public key is authorized for this principal"
            : "public key is not authorized for this principal",
        );
      }
      const implementer = roleProvider(
        runtimes.roles.implementer,
        runtimes.adapters[runtimes.roles.implementer.adapter],
      );
      const reviewer = roleProvider(
        runtimes.roles.reviewer,
        runtimes.adapters[runtimes.roles.reviewer.adapter],
      );
      const sameProvider = implementer === reviewer;
      record(
        "review independence",
        !sameProvider || !config?.review.require_independent,
        `${sameProvider ? "warning: same-provider review" : "independent review"}; implementer=${implementer}, reviewer=${reviewer}; ${config?.review.require_independent ? "required" : "optional"}`,
      );
      for (const role of /** @type {const} */ (["implementer", "reviewer"])) {
        const adapter = adapterForRole(runtimes, role);
        const probe = await adapter.probe();
        record(
          `${role} runtime`,
          probe.ok,
          `${runtimes.roles[role].adapter} ${probe.version ?? "?"} model=${runtimes.roles[role].model ?? "-"}${probe.problems.length ? `: ${probe.problems.join("; ")}` : ""}`,
        );
        if (options.live && probe.ok && runtimes.roles[role].adapter !== "fake") {
          const live = await liveProbe(adapter, runtimes, role, root);
          record(`${role} lock-down (live)`, live.ok, live.detail);
        }
      }
    } catch (error) {
      record("runtime config", false, describeError(error).message);
    }
  }
  if (options.json) print(results);
  else
    for (const result of results) print(`${result.ok ? "ok  " : "FAIL"}  ${result.name}: ${result.detail}`);
  return results.every((result) => result.ok) ? EXIT.ok : EXIT.notPassed;
}

/** @param {string[]} argv */
export async function run(argv) {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    const detail = describeError(error);
    process.stderr.write(`apocha: ${detail.message}\n`);
    process.exitCode = detail.error_class === "config" ? EXIT.usage : EXIT.error;
  }
}
