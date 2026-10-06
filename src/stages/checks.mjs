// @ts-check

import { existsSync } from "node:fs";
import path from "node:path";
import { checkDefinitionDigest, runCheck } from "../checks/runner.mjs";
import { effectiveProtectedPaths } from "../config/task.mjs";
import { snapshotCandidate } from "../git/candidate.mjs";
import { testEdits } from "../git/test-edits.mjs";
import { failureFirst, failureSignalLines, utf8Prefix } from "../util/bounded.mjs";
import { HarnessError } from "../util/errors.mjs";
import { writeJsonAtomic } from "../util/fs-safe.mjs";
import { inAnyScope } from "../util/paths.mjs";

const FINDING_EVIDENCE_BYTES = 2000;
const MAX_FINDINGS = 5;

/**
 * Turn failed checks into repair findings, failure lines first, so truncation never hides the error.
 * @param {import("../checks/runner.mjs").CheckResult[]} results
 */
export function verificationFindings(results) {
  return results
    .filter((result) => result.status === "fail")
    .slice(0, MAX_FINDINGS)
    .map((result) => {
      const parts = [
        result.stderr && `stderr:\n${result.stderr.trim()}`,
        result.stdout && `stdout:\n${result.stdout.trim()}`,
      ]
        .filter(Boolean)
        .join("\n");
      const evidence = failureFirst(parts, FINDING_EVIDENCE_BYTES);
      const exit = typeof result.exit_code === "number" ? ` (exit ${result.exit_code})` : "";
      return {
        source: /** @type {const} */ ("verification"),
        id: `check:${result.id}`,
        check_id: result.id,
        reason: utf8Prefix(
          `check ${result.id} failed${exit}${result.error ? `: ${result.error}` : ""}\n${evidence}`,
          FINDING_EVIDENCE_BYTES + 300,
        ),
      };
    });
}

/**
 * Compact history of failed verifications (the last two), so a repair round
 * can see when it is oscillating between two failures.
 * @param {import("../core/context.mjs").RunState["verification_history"]} history
 * @param {number} attempt
 * @param {import("../checks/runner.mjs").CheckResult[]} results
 */
function appendHistory(history, attempt, results) {
  const failed = results.filter((result) => result.status === "fail");
  const entry = {
    attempt,
    failed_checks: failed.map((result) => result.id),
    first_lines: Object.fromEntries(
      failed.map((result) => [
        result.id,
        failureSignalLines(`${result.stderr}\n${result.stdout}`).slice(0, 3),
      ]),
    ),
  };
  return [...history, entry].slice(-2);
}

/**
 * `checks` stage: structural checks, then the task's catalog checks, then a
 * re-snapshot proving the candidate did not change while checks ran.
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runChecksStage(_stage, ctx) {
  const started = Date.now();
  if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
  let snapshot;
  try {
    snapshot = snapshotCandidate(ctx.candidate);
  } catch (error) {
    if (error instanceof HarnessError && error.errorClass === "integrity") {
      ctx.state.last_verification = {
        status: "violation",
        duration_ms: Date.now() - started,
        candidate_digest: "",
        changed_files: [],
        checks: [{ id: "candidate-integrity", status: "fail", error: error.message }],
      };
      ctx.event("verification.finished", {
        status: "violation",
        reason: error.message,
        duration_ms: Date.now() - started,
      });
      return "violation";
    }
    throw error;
  }
  const protectedPaths = effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed);
  const outOfScope = snapshot.changed_files.filter((file) => !inAnyScope(file, ctx.task.allowed_paths));
  const protectedHits = snapshot.changed_files.filter((file) => inAnyScope(file, protectedPaths));
  const tests = testEdits(ctx.candidate, ctx.config, snapshot.changed_files, ctx.task.test_edits);
  const structural = [
    { id: "allowed-scope", status: outOfScope.length ? "fail" : "pass", files: outOfScope },
    { id: "protected-paths", status: protectedHits.length ? "fail" : "pass", files: protectedHits },
    { id: "test-edits", status: tests.offending.length ? "fail" : "pass", files: tests.offending },
  ];
  if (structural.some((check) => check.status === "fail")) {
    ctx.state.last_verification = {
      status: "violation",
      duration_ms: Date.now() - started,
      candidate_digest: snapshot.candidate_digest,
      changed_files: snapshot.changed_files,
      checks: structural,
    };
    ctx.event("verification.finished", {
      status: "violation",
      out_of_scope: outOfScope,
      protected: protectedHits,
      test_edits: tests.offending,
      duration_ms: Date.now() - started,
    });
    return "violation";
  }

  ctx.event("verification.started", { candidate_digest: snapshot.candidate_digest, checks: ctx.task.checks });
  /** @type {import("../checks/runner.mjs").CheckResult[]} */
  const results = [];
  const secretFileCache = (ctx.secretFileCache ??= { files: new Map() });
  let next = 0;
  let failed = false;
  const dependencyOptions = {
    onValidation: (/** @type {string} */ source) => ctx.event("dependencies.validation", { source }),
  };
  const worker = async () => {
    while (next < ctx.task.checks.length && !ctx.signal?.aborted) {
      if (ctx.task.fail_fast && failed) return;
      const index = next++;
      const id = ctx.task.checks[index];
      const result = await runCheck({
        check: ctx.config.checks[id],
        candidate: ctx.candidate,
        config: ctx.config,
        backend: ctx.sandboxBackend,
        secretFileCache,
        dependencyOptions,
        signal: ctx.signal,
      });
      results[index] = result;
      if (result.status !== "pass") failed = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ctx.config.limits.check_concurrency, ctx.task.checks.length) }, worker),
  );
  if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
  for (let index = next; index < ctx.task.checks.length; index++) {
    const id = ctx.task.checks[index];
    results[index] = {
      id,
      status: "skipped",
      exit_code: null,
      error: "skipped after a failing check",
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      output_digest: "",
      definition_digest: checkDefinitionDigest(ctx.config.checks[id]),
      sandbox: ctx.sandboxBackend,
      duration_ms: 0,
    };
  }
  // Publish evidence only after all workers finish, in the task's order.
  for (const result of results) {
    ctx.event("check.finished", {
      id: result.id,
      status: result.status,
      exit_code: result.exit_code,
      error: result.error,
      duration_ms: result.duration_ms,
      sandbox: result.sandbox,
    });
  }
  /** @type {NonNullable<import("../core/context.mjs").RunState["last_verification"]>["tests_on_base"]} */
  const testsOnBase = [];
  const runFiles = ctx.config.tests.run_files;
  if (runFiles && results.every((result) => result.status === "pass")) {
    const files = [...tests.added, ...tests.modified]
      .filter((file) => existsSync(path.join(ctx.candidate.root, file)))
      .sort();
    const support = tests.added.filter((file) => existsSync(path.join(ctx.candidate.root, file)));
    for (const [index, file] of files.entries()) {
      if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
      if (index >= 10) {
        testsOnBase.push({ path: file, result: "not_run" });
        continue;
      }
      const result = await runCheck({
        check: runFiles,
        candidate: ctx.candidate,
        config: ctx.config,
        backend: ctx.sandboxBackend,
        secretFileCache,
        dependencyOptions,
        signal: ctx.signal,
        baseOverlay: [...new Set([file, ...support])],
        files: [path.posix.relative(runFiles.cwd, file)],
      });
      if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
      const classification =
        result.error || result.exit_code === null || result.status === "infra_error"
          ? "error"
          : result.exit_code === 0
            ? "passes_on_base"
            : "fails_on_base";
      testsOnBase.push({ path: file, result: classification });
      ctx.event("test-on-base.finished", { path: file, result: classification });
    }
    const passing = testsOnBase.filter((entry) => entry.result === "passes_on_base");
    if (ctx.task.new_tests_must_fail_on_base && passing.length) {
      const reason = `${passing.map((entry) => entry.path).join(", ")} pass on the base code and so do not test the change`;
      results.push({
        id: "tests-fail-before",
        status: "fail",
        exit_code: null,
        error: reason,
        stdout: "",
        stderr: reason,
        stdout_truncated: false,
        stderr_truncated: false,
        output_digest: "",
        definition_digest: "",
        sandbox: ctx.sandboxBackend,
        duration_ms: 0,
      });
      ctx.event("check.finished", { id: "tests-fail-before", status: "fail", error: reason });
    }
  }
  const after = snapshotCandidate(ctx.candidate);
  const changedDuringChecks = after.candidate_digest !== snapshot.candidate_digest;

  const statuses = results.map((result) => result.status);
  const status = changedDuringChecks
    ? "violation"
    : statuses.includes("infra_error")
      ? "infra_error"
      : statuses.includes("fail")
        ? "fail"
        : "pass";
  const evidenceFile = path.join(
    ctx.store.dir(ctx.runId),
    `verification-${String(ctx.state.attempt).padStart(2, "0")}.json`,
  );
  const duration_ms = Date.now() - started;
  writeJsonAtomic(evidenceFile, {
    duration_ms,
    candidate_digest: snapshot.candidate_digest,
    changed_files: snapshot.changed_files,
    structural,
    results,
    tests_on_base: testsOnBase,
  });
  ctx.state.last_verification = {
    status,
    duration_ms,
    tests_on_base: testsOnBase,
    candidate_digest: snapshot.candidate_digest,
    changed_files: snapshot.changed_files,
    checks: [
      ...structural,
      ...results.map((result) => ({
        id: result.id,
        status: result.status,
        exit_code: result.exit_code,
        error: result.error,
        definition_digest: result.definition_digest,
        sandbox: result.sandbox,
        output_digest: result.output_digest,
        duration_ms: result.duration_ms,
      })),
      ...(changedDuringChecks
        ? [{ id: "post-check-identity", status: "fail", error: "candidate changed while checks ran" }]
        : []),
    ],
  };
  ctx.event("verification.finished", { status, candidate_digest: snapshot.candidate_digest, duration_ms });
  if (status === "fail") {
    ctx.state.findings = verificationFindings(results);
    ctx.state.verification_history = appendHistory(
      ctx.state.verification_history,
      ctx.state.attempt,
      results,
    );
  }
  return status;
}
