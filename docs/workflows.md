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
    implement: { kind: "agent", role: "implementer", on: { done: "verify", no_changes: "ESCALATED" } },
    verify: { kind: "checks", on: { pass: "review", fail: "repair", violation: "FAILED", infra_error: "ESCALATED" } },
    repair: { kind: "budget", counter: "repairs", on: { available: "implement", exhausted: "ESCALATED" } },
    review: { kind: "review", role: "reviewer", on: { PASS: "promote", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" } },
    promote: { kind: "promote", on: { done: "PASSED" } },
  },
};
```

## Stage kinds

| Kind | Outcomes | What it does |
|---|---|---|
| `agent` | `done`, `no_changes` | Runs the implementer with the task bundle and any findings; snapshots the candidate |
| `checks` | `pass`, `fail`, `violation`, `infra_error` | Structural checks (scope, protected paths, test edits), then the task's catalog checks, then a re-snapshot. A failure becomes findings for the next attempt. |
| `review` | `PASS`, `FIX`, `ESCALATE`, `too_large` | Runs the reviewer on the verified candidate with the full diff; validates the decision and its digest binding |
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

## Test edit check

The `test-edits` structural check compares the final candidate against the base commit,
even when edits bypassed the tools. For existing files matching `tests.paths`,
`additive` fails on any removed or changed line or file deletion, and `new-files`
fails on any modification or deletion. Pure added lines pass under `additive`.
The `allowed` policy passes this check. New test files are permitted by every
policy, subject to the normal scope and protected-path checks. Violations list
the offending files and end the run as `FAILED` before catalog checks or review.

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
