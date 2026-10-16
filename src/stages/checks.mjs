// @ts-check

import { existsSync } from "node:fs";
import path from "node:path";
import { runFixers } from "../checks/fixers.mjs";
import { checkDefinitionDigest, runCheck } from "../checks/runner.mjs";
import { canRunTestPath, isJudgeInput } from "../config/project.mjs";
import { effectiveProtectedPaths } from "../config/task.mjs";
import { snapshotCandidate } from "../git/candidate.mjs";
import { testEdits } from "../git/test-edits.mjs";
import { hasRunnableTests, preservesAssertions } from "../git/test-source.mjs";
import { failureFirst, failureSignalLines, utf8Prefix } from "../util/bounded.mjs";
import { HarnessError } from "../util/errors.mjs";
import { writeJsonAtomic } from "../util/fs-safe.mjs";
import { git } from "../util/git.mjs";
import { inAnyScope, isForbidden } from "../util/paths.mjs";

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
 * `checks` stage: automatic fixers, structural and catalog checks, then a
 * re-snapshot proving the candidate did not change while checks ran.
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runChecksStage(_stage, ctx) {
  const started = Date.now();
  if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
  let snapshot;
  /** @type {import("../checks/fixers.mjs").FixerResult[]} */
  let fixers = [];
  try {
    snapshot = snapshotCandidate(ctx.candidate);
    fixers = await runFixers(ctx, snapshot.changed_files);
    if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
    if (fixers.some((fixer) => fixer.changed.length)) snapshot = snapshotCandidate(ctx.candidate);
  } catch (error) {
    if (error instanceof HarnessError && error.errorClass === "integrity") {
      ctx.state.last_verification = {
        status: "violation",
        duration_ms: Date.now() - started,
        candidate_digest: "",
        changed_files: [],
        judge_input_changes: [],
        fixers,
        checks: [{ id: "candidate-integrity", status: "fail", error: error.message }],
      };
      ctx.event("verification.finished", {
        status: "violation",
        judge_inputs: [],
        reason: error.message,
        duration_ms: Date.now() - started,
      });
      return "violation";
    }
    throw error;
  }
  const protectedPaths = effectiveProtectedPaths(ctx.task, ctx.config, ctx.governance.edits_allowed);
  const outOfScope = snapshot.changed_files.filter((file) => !inAnyScope(file, ctx.task.allowed_paths));
  const protectedHits = snapshot.changed_files.filter(
    (file) => inAnyScope(file, protectedPaths) || isForbidden(file, ctx.config.paths.forbidden),
  );
  const judgeFiles = snapshot.changed_files.filter(
    (file) =>
      isJudgeInput(ctx.config, file) &&
      !inAnyScope(file, protectedPaths) &&
      !isForbidden(file, ctx.config.paths.forbidden) &&
      !(ctx.governance.edits_allowed && inAnyScope(file, ctx.config.paths.governance)),
  );
  const judgeDeclarations = new Map(
    (ctx.state.implementation?.judge_input_changes ?? []).map((entry) => [entry.path, entry]),
  );
  for (const entry of ctx.task.judge_input_changes ?? []) judgeDeclarations.set(entry.path, entry);
  /** @type {NonNullable<import("../core/context.mjs").RunState["last_verification"]>["judge_input_changes"]} */
  const judgeChanges = [];
  const undeclaredJudgeInputs = [];
  for (const file of [...judgeFiles].sort()) {
    const declaration = judgeDeclarations.get(file);
    if (!declaration && !ctx.integration) {
      undeclaredJudgeInputs.push(file);
      continue;
    }
    const existed =
      git(ctx.candidate.root, ["cat-file", "-e", `${ctx.candidate.base_commit}:${file}`], {
        allowFailure: true,
      }).status === 0;
    const exists =
      git(ctx.candidate.root, ["cat-file", "-e", `:${file}`], { allowFailure: true }).status === 0;
    judgeChanges.push({
      path: file,
      change: !existed ? "added" : exists ? "modified" : "deleted",
      kind: declaration?.kind ?? "migrate",
      reason: declaration?.reason ?? "merged from the integration topic",
      declared_by: ctx.task.judge_input_changes?.some((entry) => entry.path === file)
        ? "task"
        : declaration
          ? "implementer"
          : "integration",
    });
  }
  const tests = testEdits(ctx.candidate, ctx.config, snapshot.changed_files, ctx.task.test_edits);
  const testPolicyEvidence = {
    effective_policy: tests.effective_policy,
    ...(tests.reason ? { reason: tests.reason } : {}),
  };
  const structural = [
    {
      id: "judge-inputs",
      status: undeclaredJudgeInputs.length ? "fail" : "pass",
      files: undeclaredJudgeInputs,
    },
    { id: "allowed-scope", status: outOfScope.length ? "fail" : "pass", files: outOfScope },
    { id: "protected-paths", status: protectedHits.length ? "fail" : "pass", files: protectedHits },
    {
      id: "test-edits",
      status: tests.offending.length ? "fail" : "pass",
      files: tests.effective_policy === "justified" ? tests.changed : tests.offending,
      ...testPolicyEvidence,
    },
  ];
  if (structural.some((check) => check.status === "fail")) {
    ctx.state.last_verification = {
      status: "violation",
      duration_ms: Date.now() - started,
      candidate_digest: snapshot.candidate_digest,
      changed_files: snapshot.changed_files,
      checks: structural,
      judge_input_changes: judgeChanges,
      ...testPolicyEvidence,
      fixers,
    };
    writeJsonAtomic(
      path.join(ctx.store.dir(ctx.runId), `verification-${String(ctx.state.attempt).padStart(2, "0")}.json`),
      { ...ctx.state.last_verification, structural },
    );
    ctx.event("verification.finished", {
      status: "violation",
      ...testPolicyEvidence,
      out_of_scope: outOfScope,
      protected: protectedHits,
      test_edits: tests.offending,
      judge_inputs: undeclaredJudgeInputs,
      duration_ms: Date.now() - started,
    });
    return "violation";
  }

  ctx.event("verification.started", { candidate_digest: snapshot.candidate_digest, checks: ctx.task.checks });
  const secretFileCache = (ctx.secretFileCache ??= { files: new Map() });
  const dependencyOptions = {
    onValidation: (/** @type {string} */ source) => ctx.event("dependencies.validation", { source }),
  };
  /** @param {string[]} [baseFiles] */
  const runCatalog = async (baseFiles) => {
    /** @type {import("../checks/runner.mjs").CheckResult[]} */
    const results = [];
    let next = 0;
    let failed = false;
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
          signingKey: ctx.runtimes?.signing?.key,
          secretFileCache,
          dependencyOptions,
          signal: ctx.signal,
          ...(baseFiles ? { baseFiles } : {}),
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
        sandbox: ctx.config.checks[id].unsandboxed ? "none" : ctx.sandboxBackend,
        duration_ms: 0,
      };
    }

    return results;
  };
  const results = await runCatalog();
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
  /** @type {import("../core/context.mjs").TestChangeEvidence[]} */
  const testChanges = [];
  const declarations = new Map((ctx.task.test_changes ?? []).map((entry) => [entry.path, entry]));
  const fixtureFiles = new Set(
    tests.modified.filter((file) => {
      if (declarations.get(file)?.kind !== "fixture") return false;
      const base = String(git(ctx.candidate.root, ["show", `${ctx.candidate.base_commit}:${file}`]).stdout);
      const next = git(ctx.candidate.root, ["show", `:${file}`], { allowFailure: true });
      return !hasRunnableTests(base) && (next.status !== 0 || !hasRunnableTests(String(next.stdout)));
    }),
  );
  const runFiles = ctx.config.tests.run_files;
  if (runFiles && results.every((result) => result.status === "pass")) {
    const files = [...tests.added, ...tests.modified]
      .filter((file) => !fixtureFiles.has(file) && existsSync(path.join(ctx.candidate.root, file)))
      .sort(
        (a, b) => Number(tests.changed.includes(b)) - Number(tests.changed.includes(a)) || a.localeCompare(b),
      );
    const support = tests.added.filter((file) => existsSync(path.join(ctx.candidate.root, file)));
    let executed = 0;
    for (const file of files) {
      if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
      if (!canRunTestPath(ctx.config, file) || executed >= 10) {
        testsOnBase.push({ path: file, result: "not_run" });
        continue;
      }
      executed++;
      const result = await runCheck({
        check: runFiles,
        candidate: ctx.candidate,
        config: ctx.config,
        backend: ctx.sandboxBackend,
        signingKey: ctx.runtimes?.signing?.key,
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
    const evidenceNeeded = tests.changed.filter(
      (file) => !fixtureFiles.has(file) && canRunTestPath(ctx.config, file),
    );
    const unevaluated = tests.changed.filter(
      (file) => !fixtureFiles.has(file) && !canRunTestPath(ctx.config, file),
    );
    if (
      tests.effective_policy === "justified" &&
      (evidenceNeeded.length || unevaluated.length || fixtureFiles.size)
    ) {
      const reasons = [];
      if (evidenceNeeded.length > 10)
        reasons.push(`${evidenceNeeded.length} changed existing test files exceeds the limit of 10`);
      for (const file of [...evidenceNeeded.slice(0, 10), ...unevaluated, ...fixtureFiles].sort()) {
        if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
        const modified = existsSync(path.join(ctx.candidate.root, file));
        const declaration = declarations.get(file);
        const declared = {
          declared: Boolean(declaration),
          ...(declaration ? { kind: declaration.kind, reason: declaration.reason } : {}),
        };
        const baseSource = String(
          git(ctx.candidate.root, ["show", `${ctx.candidate.base_commit}:${file}`]).stdout,
        );
        const assertionEvidence = modified
          ? {
              assertions_preserved: preservesAssertions(
                baseSource,
                String(git(ctx.candidate.root, ["show", `:${file}`]).stdout),
              ),
            }
          : {};
        if (fixtureFiles.has(file)) {
          testChanges.push({
            path: file,
            change: modified ? "modified" : "deleted",
            ...declared,
            ...assertionEvidence,
            verdict: "declared_fixture",
          });
          ctx.event("test-change.finished", { path: file, verdict: "declared_fixture" });
          continue;
        }
        if (!canRunTestPath(ctx.config, file)) {
          testChanges.push({
            path: file,
            change: modified ? "modified" : "deleted",
            ...declared,
            ...assertionEvidence,
            verdict: "unevaluated",
          });
          reasons.push(
            `${file} is outside tests.run_files.paths, so this change cannot be evaluated; restore it or only add to it`,
          );
          ctx.event("test-change.finished", { path: file, verdict: "unevaluated" });
          continue;
        }
        const newOnBase = modified ? testsOnBase.find((entry) => entry.path === file)?.result : undefined;
        const result = await runCheck({
          check: runFiles,
          candidate: ctx.candidate,
          config: ctx.config,
          backend: ctx.sandboxBackend,
          signingKey: ctx.runtimes?.signing?.key,
          secretFileCache,
          dependencyOptions,
          signal: ctx.signal,
          baseFiles: [file],
          files: [path.posix.relative(runFiles.cwd, file)],
        });
        if (ctx.signal?.aborted) throw new HarnessError("infra", "aborted", "run aborted");
        const oldOnCandidate =
          result.error || result.exit_code === null || result.status === "infra_error"
            ? "error"
            : result.exit_code === 0
              ? "old_passes_on_candidate"
              : "old_fails_on_candidate";
        const note =
          declaration?.kind === "refactor" && oldOnCandidate === "old_fails_on_candidate"
            ? "The refactor declaration did not match the execution evidence: the old test fails on the candidate; judged by the normal behaviour change rules."
            : undefined;
        const verdict =
          declaration?.kind === "fixture" ||
          oldOnCandidate === "error" ||
          (modified && (!newOnBase || newOnBase === "error" || newOnBase === "not_run"))
            ? "error"
            : oldOnCandidate === "old_passes_on_candidate"
              ? declaration?.kind === "refactor"
                ? "refactor"
                : modified && newOnBase === "fails_on_base" && assertionEvidence.assertions_preserved === true
                  ? "strengthened"
                  : "unnecessary"
              : newOnBase === "passes_on_base"
                ? "weakened"
                : "necessary";
        testChanges.push({
          path: file,
          ...declared,
          change: modified ? "modified" : "deleted",
          old_on_candidate: oldOnCandidate,
          ...assertionEvidence,
          ...(note ? { note } : {}),
          ...(modified ? { new_on_base: newOnBase ?? "error" } : {}),
          verdict,
        });
        if (verdict === "unnecessary")
          reasons.push(
            `the old version of ${file} still passes on the new code, so the change was not needed; restore it, only add to it, or keep every existing assertion and make the file fail on the old code`,
          );
        else if (verdict === "weakened")
          reasons.push(
            `${file} now passes on both the old and the new code, so it no longer distinguishes them`,
          );
        else if (verdict === "error") reasons.push(`could not establish test change evidence for ${file}`);
        ctx.event("test-change.finished", { path: file, old_on_candidate: oldOnCandidate, verdict });
      }
      const status = testChanges.some((entry) => entry.verdict === "error")
        ? "infra_error"
        : reasons.length
          ? "fail"
          : "pass";
      const reason = reasons.join("\n");
      results.push({
        id: "test-changes",
        status,
        exit_code: null,
        error: reason || null,
        stdout: "",
        stderr: reason,
        stdout_truncated: false,
        stderr_truncated: false,
        output_digest: "",
        definition_digest: "",
        sandbox: ctx.sandboxBackend,
        duration_ms: 0,
      });
      ctx.event("check.finished", { id: "test-changes", status, error: reason || null });
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
  /** @type {NonNullable<import("../core/context.mjs").RunState["last_verification"]>["base_judge"]} */
  let baseJudge;
  if (
    results.every((result) => result.status === "pass") &&
    judgeChanges.length &&
    snapshotCandidate(ctx.candidate).candidate_digest === snapshot.candidate_digest
  ) {
    const restored = judgeChanges.map((change) => change.path);
    const baseResults = await runCatalog(restored);
    const status = baseResults.some((result) => result.status === "infra_error")
      ? "infra_error"
      : baseResults.some((result) => result.status === "fail")
        ? "fail"
        : "pass";
    baseJudge = {
      status,
      restored,
      checks: baseResults.map(({ id, status, exit_code, duration_ms }) => ({
        id,
        status,
        exit_code,
        duration_ms,
      })),
    };
    const failing = baseResults.filter((result) => result.status === "fail").map((result) => result.id);
    ctx.event("base-judge.finished", { status, failed_checks: failing });
    if (status === "fail")
      ctx.state.reason = `declared judge input changes are needed for checks to pass: ${failing.join(", ")} fail with the base versions of ${restored.join(", ")}`;
  }
  const after = snapshotCandidate(ctx.candidate);
  const changedDuringChecks = after.candidate_digest !== snapshot.candidate_digest;

  const statuses = results.map((result) => result.status);
  const status = changedDuringChecks
    ? "violation"
    : baseJudge?.status === "infra_error"
      ? "infra_error"
      : baseJudge?.status === "fail"
        ? "loosened"
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
    ...testPolicyEvidence,
    duration_ms,
    candidate_digest: snapshot.candidate_digest,
    changed_files: snapshot.changed_files,
    structural,
    fixers,
    results,
    ...(baseJudge ? { base_judge: baseJudge } : {}),
    judge_input_changes: judgeChanges,
    test_changes: testChanges,
    tests_on_base: testsOnBase,
  });
  ctx.state.last_verification = {
    status,
    ...(baseJudge ? { base_judge: baseJudge } : {}),
    judge_input_changes: judgeChanges,
    ...testPolicyEvidence,
    duration_ms,
    test_changes: testChanges,
    tests_on_base: testsOnBase,
    fixers,
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
  ctx.event("verification.finished", {
    status,
    ...(status === "violation" ? { judge_inputs: undeclaredJudgeInputs } : {}),
    candidate_digest: snapshot.candidate_digest,
    duration_ms,
  });
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
