# Apocha's run history

These are self-hosted runs: Apocha developing itself on one machine with one operator
who wrote the tasks. Every run is counted whatever its outcome: PASSED, FAILED,
ESCALATED, or ERROR. This is not a benchmark and says nothing about other repositories.
Most runs used one implementer and one reviewer runtime (see the runtimes table below).

As of 2026-10-16, main at `63547bb`. Older public figures counted successful
deliveries only; this snapshot includes every finished run.

## Runs

The window counts all runs and gives their earliest and latest creation timestamps:
107 runs recorded from 2026-10-05 to 2026-10-16.

Outcomes group all runs by outcome and workflow, and finished runs by recorded error class.

| Workflow | PASSED | ESCALATED | ERROR | FAILED | Finished |
| --- | --- | --- | --- | --- | --- |
| code-delivery | 92 | 8 | 1 | 0 | 101 |
| integrate | 3 | 2 | 0 | 1 | 6 |
| All | 95 | 10 | 1 | 1 | 107 |

Error classes: infra 1. ESCALATED includes runs stopped on purpose by a guard,
for example an invalid review or a confirmed blocked claim. FAILED is a policy
or scope violation.

## Tasks

Tasks group finished code-delivery runs by exact task ID in creation order.

| Measure | Value | Definition |
| --- | --- | --- |
| Tasks | 95 | Distinct task IDs with a finished code-delivery run. |
| Delivered | 92 (96.8%) | Delivered tasks as a percentage of tasks with finished code-delivery runs. |
| First run passed | 86 (90.5%) | Tasks whose earliest finished code-delivery run passed as a percentage of tasks. |
| First run passed with no repair | 77 (81.1%) | Tasks whose earliest finished code-delivery run passed without repairs as a percentage of tasks. |
| Finished runs per delivered task | 1.10 | Finished code-delivery runs divided by delivered tasks. |

## Repairs

Repair counts group passed code-delivery runs by their number of repair rounds.

| Repairs | Passed code-delivery runs |
| --- | --- |
| 0 | 82 |
| 1 | 8 |
| 2 | 2 |

- No repair: 89.1%. Passed code-delivery runs with no repairs as a percentage of passed code-delivery runs.
- At most one: 97.8%. Passed code-delivery runs with at most one repair as a percentage of passed code-delivery runs.

## Reviews

Review decisions and findings count review events in finished runs:
107 reviews; PASS 95, ESCALATE 4, FIX 8.
FIX rate: 7.5%. FIX decisions as a percentage of review decisions in finished runs.

## Checks

Check executions in finished runs group by check ID, with nearest-rank duration percentiles.
Fail rate: Failed check executions as a percentage of check executions in finished runs.

| Check | Executions | Failures | Fail rate |
| --- | --- | --- | --- |
| lint | 117 | 2 | 1.7% |
| typecheck | 115 | 0 | 0% |
| test | 115 | 10 | 8.7% |
| sandbox-selftest | 9 | 2 | 22.2% |
| test-changes | 8 | 1 | 12.5% |

## Runtimes

Runs with recorded runtimes group by role, adapter, and model, summing role usage.
Pass rate: Passed runs as a percentage of finished runs in each runtime group.

| Role | Adapter | Model | Runs | Pass rate |
| --- | --- | --- | --- | --- |
| implementer | codex | gpt-6.1-sol | 103 | 90.3% |
| reviewer | pi | gpt-6-luna | 21 | 95.2% |
| reviewer | claude-code | claude-sonnet-5-5 | 79 | 94.9% |

## Duration and receipt coverage

Run and accumulated stage durations use nearest-rank median and p90 over available values.
Run duration: median 7.5 min, p90 17.9 min.

Receipts: 88 of 102 first-parent commits on main carry a receipt. The 14 commits without
a receipt are manual commits: 13 from 2026-10-05, the day the harness was bootstrapped
(including the first CI workflow and the rename), and one version bump on 2026-10-06;
every first-parent commit on main after 2026-10-06 carries a receipt.
Coverage counts first-parent commits carrying a receipt out of all first-parent commits.

## Reproducing the numbers

The run store lives in the local `.git/apocha` directory and is not pushed, so the
run-level numbers cannot be recomputed from a clone. On the machine with that store:

```bash
apocha metrics
apocha analytics --format md
```

Receipts can be fetched and checked from a clone:

```bash
git fetch origin refs/notes/apocha:refs/notes/apocha
apocha metrics
apocha receipt <commit>
```

Use the deliveries view of `apocha metrics` for receipts; it covers only work that
passed. See [Receipts](receipts.md) for verification and signature checks.
