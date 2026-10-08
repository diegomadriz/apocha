// @ts-check
import { warnCatalogUnsandboxedChecks } from "../checks/sandbox.mjs";
import { selectChecks } from "../config/project.mjs";
import { taskDigest, validateTask } from "../config/task.mjs";
import { snapshotCandidate } from "../git/candidate.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git } from "../util/git.mjs";

/**
 * `seed` stage for integration: merge the topic into the candidate without
 * committing, then derive the integration task from what changed.
 * @param {import("../core/workflow.mjs").StageDefinition} _stage
 * @param {import("../core/context.mjs").RunContext} ctx
 */
export async function runMergeSeedStage(_stage, ctx) {
  const integration = ctx.integration;
  if (!integration)
    throw new HarnessError("config", "invalid_workflow", "seed stage needs integration inputs");
  const env = {
    GIT_AUTHOR_NAME: "apocha",
    GIT_AUTHOR_EMAIL: "apocha@localhost",
    GIT_COMMITTER_NAME: "apocha",
    GIT_COMMITTER_EMAIL: "apocha@localhost",
  };
  const merged = git(
    ctx.candidate.root,
    ["merge", "--no-ff", "--no-commit", "--quiet", integration.topic_commit],
    { allowFailure: true, env },
  );
  if (merged.status !== 0) {
    const conflicts = String(git(ctx.candidate.root, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout)
      .split("\0")
      .filter(Boolean)
      .sort();
    if (!conflicts.length)
      throw new HarnessError(
        "infra",
        "merge_failed",
        `git merge failed: ${String(merged.stderr).trim().slice(0, 300)}`,
      );
    ctx.state.seed = { conflicted_files: conflicts };
    ctx.state.reason = `merge conflict in ${conflicts.length} file(s)`;
    ctx.event("merge.conflict", { files: conflicts });
    return "conflict";
  }
  // The merge state (MERGE_HEAD) is not needed: promotion records the topic as a parent.
  git(ctx.candidate.root, ["merge", "--quit"], { allowFailure: true });
  const snapshot = snapshotCandidate(ctx.candidate);
  if (!snapshot.changed_files.length) {
    ctx.state.reason = "the topic adds no changes to the base";
    return "empty";
  }
  const checks = integration.checks ?? selectChecks(ctx.config, snapshot.changed_files);
  if (!checks.length)
    throw new HarnessError(
      "config",
      "no_checks",
      "no checks selected for this integration; pass --checks or add check_selection rules",
    );
  const unsandboxed = checks.filter((id) => ctx.config.checks[id].unsandboxed);
  if (unsandboxed.length && !ctx.governance.edits_allowed)
    throw new HarnessError(
      "config",
      "unsandboxed_approval",
      `unsandboxed checks ${unsandboxed.join(", ")} require --allow-governance-edits with a non-empty --reason`,
    );
  ctx.task = validateTask(
    {
      task_id: ctx.task.task_id,
      description: ctx.task.description,
      acceptance_criteria: [
        ...checks.map((id) => `The merged tree passes ${id}.`),
        "The combined change is coherent with the base.",
      ],
      allowed_paths: snapshot.changed_files,
      checks,
      max_repair_attempts: ctx.task.max_repair_attempts,
      test_edits: integration.testEdits ?? ctx.task.test_edits,
    },
    ctx.config,
  );
  warnCatalogUnsandboxedChecks(ctx);
  ctx.taskDigest = taskDigest(ctx.task);
  ctx.state.seed = { changed_files: snapshot.changed_files.length, checks };
  ctx.state.implementation = {
    summary: `Integration of ${integration.topic} into ${integration.onto}`,
    criteria_evidence: [
      ...checks.map((id, index) => ({
        criterion: index + 1,
        evidence: [{ kind: /** @type {const} */ ("check"), check_id: id }],
      })),
      {
        criterion: checks.length + 1,
        evidence: [{ kind: "inspection", note: "Judged by the reviewer from the merged diff." }],
      },
    ],
    unresolved_uncertainties: [],
  };
  ctx.event("merge.finished", {
    changed_files: snapshot.changed_files.length,
    checks,
    test_edits: ctx.task.test_edits,
  });
  return "done";
}
