# Workflows

A workflow is data: a start stage and a table of stages. The engine runs it. Adding a workflow
means writing a definition, not changing the engine.

```js
// src/workflows/code-delivery.mjs
export default {
  id: "code-delivery",
  version: 1,
  start: "implement",
  stages: {
    implement: { kind: "agent", role: "implementer", on: { done: "verify", no_changes: "ESCALATED", blocked: "blocked-review" } },
    verify: { kind: "checks", on: { pass: "review", fail: "repair", violation: "FAILED", infra_error: "ESCALATED" } },
    repair: { kind: "budget", counter: "repairs", on: { available: "implement", exhausted: "ESCALATED" } },
    "blocked-review": { kind: "review", role: "reviewer", mode: "blocked-claim", on: { PASS: "repair", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" } },
    review: { kind: "review", role: "reviewer", on: { PASS: "promote", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" } },
    promote: { kind: "promote", on: { done: "PASSED" } },
  },
};
```

## Stage kinds

| Kind | Outcomes | What it does |
|---|---|---|
| `agent` | `done`, `no_changes`, `blocked` | Runs the implementer with the task bundle and any findings; snapshots completed candidates or records a blocked reason |
| `checks` | `pass`, `fail`, `violation`, `infra_error` | Automatic fixers, then structural checks (scope, protected paths, test edits), then the task's catalog checks, then a re-snapshot. A failure becomes findings for the next attempt. |
| `review` | `PASS`, `FIX`, `ESCALATE`, `too_large` | Runs the reviewer on the verified candidate, or confirms a blocked claim with `mode: "blocked-claim"` without checks; validates the decision and its digest binding |
| `budget` | `available`, `exhausted` | Spends one unit of a counter (`repairs` is bounded by the task) |
| `human` | `approve`, `reject` | Pauses the run until `apocha resume <run> --decision approve\|reject` |
| `promote` | `done` | Commits onto the batch ref and writes the receipt, under the lock |
| `seed` | `done`, `conflict`, `empty` | Deterministic preparation; in `integrate`, merges the topic and derives the task from what changed |

Terminal states: `PASSED`, `FAILED`, `ESCALATED`. `PAUSED` and `ERROR` come from errors, not
from definitions (see [architecture.md](architecture.md#the-engine)).

Catalog checks run with at most `limits.check_concurrency` workers (default 2),
each in a separate writable workspace and sandbox. Results, `check.finished`
events, verification files, and receipts retain the task's check order regardless
of finish order. With task `fail_fast: true`, checks not yet started after a
failure are recorded as `skipped`; running checks finish. Aborts stop running
checks and prevent new checks from starting. Per-check `duration_ms` and the
checks stage's total wall time are recorded in verification evidence.
Base test runs remain sequential and start only after all catalog checks pass.

An implementer that makes tool calls but stops without submitting, and without a
runtime failure, gets one continuation in the same candidate. The new invocation has
its own tool budget and a prompt to finish and submit. The `implementer.continued`
event records it; it spends no retry, repair, or attempt. A second missing result
escalates with `agent/no_result`. Invocations with no tool calls keep the normal retry
policy, and reviewers are unchanged.

Both built-in workflows send `blocked` reports to `blocked-review`, even after edits.
No checks run. The independent reviewer sees the task, criteria, scope, reason,
summary, current diff (which may be empty), and any latest verification results.

- `ESCALATE` confirms the conflict without spending a repair. The run ends with
  `implementer reported blocked; reviewer confirmed: <reviewer reason>`.
- `FIX` rejects the claim and sends findings to `repair`, spending the usual budget.
- `PASS` becomes `FIX`, with a finding to complete the task.

An exhausted repair budget escalates. The event log keeps the claim in
`implementer.blocked` and the reviewer decision in `blocked.confirmed` or
`blocked.rejected`. State retains `blocked_claims` after successful repairs.
Analytics count blocked runs, reports, confirmations, and rejections.

## Automatic fixers

At the start of every verification attempt, selected fixers run sequentially once,
before structural and catalog checks. Each uses the check sandbox, npm dependency
handling, environment allowlist, and a fresh tree from the candidate. With no eligible
files the fixer is skipped. Eligible files are added or modified existing regular files
inside `allowed_paths`, excluding read-only, protected, design reference, forbidden,
and governance paths (even when governance edits are authorized).

Only successful exit-zero executions copy changed contents back, and only for files
in the eligible `{files}` list. Other writes, creations, deletions, and unsafe replacements
are ignored and recorded as `ignored_changes`. Non-zero exits and timeouts copy nothing;
catalog checks still decide whether verification passes. Fixers cannot create or delete
candidate files or copy changes outside the eligible list.

Every fixer emits `fixer.finished` with status, changed paths, and ignored changes.
Verification records include `fixers`; receipts include each ID, definition digest,
status, and changed paths. Verification snapshots follow fixers, so the candidate digest
and the reviewer's diff cover the fixed content.

## Test edit check

The `test-edits` structural check compares the final candidate against the base commit,
even when edits bypassed the tools. For existing files matching `tests.paths`,
`additive` fails on any removed or changed line or file deletion, and `new-files`
fails on any modification or deletion. Pure added lines pass under `additive`.
The `allowed` policy passes this check. New test files are permitted by every
policy, subject to the normal scope and protected-path checks. Violations list
the offending files and end the run as `FAILED` before catalog checks or review.

Under `justified`, after catalog checks pass, `tests.run_files` supplies evidence
for each non-additively modified or deleted existing test (up to 10 files):

| Verdict | Evidence | Outcome |
|---|---|---|
| `strengthened` | Modified file, old version passes on candidate, new version fails on base, every existing assertion preserved | Pass |
| `unnecessary` | Old version passes on candidate without a declared refactor or qualifying strengthening | Fail; restore it, only add to it, or preserve every assertion and make it fail on base |
| `necessary` | Old version fails on candidate and new version fails on base, or file deleted | Pass |
| `weakened` | Old version fails on candidate but new version passes on base | Fail |
| `refactor` | Declared refactor whose old version passes on candidate | Pass; assertion preservation remains advisory |
| `declared_fixture` | Declared support file with no runnable tests | Pass without evidence runs |
| `error` | Execution evidence cannot be established | Infrastructure error |

A refactor whose old version fails follows the normal behaviour change rules.
Verification `test_changes`, `test-change.finished` events, review bundles and
receipts retain these verdicts.

## Tests against the base code

When `tests.run_files` is configured, successful catalog checks are followed by
individual base runs of the candidate's added or modified tests (up to 10).
Each fresh workspace contains the base tree, that test, and added test-support
files under `tests.paths`, with the normal sandbox, scratch directories, environment
allowlist, npm dependency policy, and removal of forbidden paths. Deleted tests
are skipped; files beyond the limit are `not_run`. Exit zero is `passes_on_base`,
a non-zero exit is `fails_on_base`, and timeouts or infrastructure problems are `error`.

The reviewer sees `tests_on_base`; promoted receipts store `tests.on_base`.
Passing on base is evidence to assess, not proof a test is bad: a refactor or
new coverage of existing behavior can pass legitimately. By default it is advisory.
A task can set `new_tests_must_fail_on_base: true` to turn passing-on-base files
into a failing `tests-fail-before` check with findings naming the files.
Normal repair limits apply, including escalation when exhausted. Errors never
count as evidence either way. Without `tests.run_files`, no base tests run.

## Validation

`validateWorkflow` (in `src/core/workflow.mjs`) runs when a workflow is loaded and refuses a
definition when:

- a stage kind is unknown, or an `agent` or `review` stage has no role;
- any outcome of a stage is not routed, or a route names an outcome the kind cannot produce;
- a target is neither a stage nor a terminal state;
- a stage is unreachable from `start`, or no terminal state is reachable.

## Built-in workflows

- **`code-delivery`** (`apocha run`): above.
- **`integrate`** (`apocha integrate`): `merge` (seed) → `verify` → `review` → `promote`, with
  `repair` → `implement` when the merged tree fails. The topic becomes the promoted commit's
  second parent. Checks come from `--checks` or from `check_selection` rules over the changed
  paths.

## Designing other pipelines

The stage kinds are the building blocks for other gated pipelines. Two examples this design is
meant to cover:

- **Content publishing**: `seed` (deterministic projection) → `checks` (schema and privacy
  checks) → `review` → `human` (owner approves the wording) → `promote`.
- **Repository readiness**: `seed` (masked replica) → `agent` (prepare) → `checks` → `review` →
  `budget`/`agent` (fix) → `human` (approve publication) → `promote`.

A new stage kind needs an implementation in `src/stages/` and its outcomes in `STAGE_OUTCOMES`.
Keep stages deterministic where possible: agents fill bounded steps, and the engine owns the
flow.
