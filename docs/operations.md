# Operations

## Runs

Every `run` and `integrate` creates a run record under `<git-common-dir>/panagent/runs/<run-id>/`,
whatever its outcome. The run ID is `<task-id>-<UTC timestamp>-<4 hex>`, so reruns of a task never
overwrite each other.

```bash
panagent runs                 # newest first: outcome, run id, workflow, reason
panagent show <run-id>        # run.json: inputs, state, outcome
panagent show <run-id> --events   # the event log
```

Outcomes: `RUNNING`, `PASSED`, `FAILED`, `ESCALATED`, `PAUSED`, `ERROR`.

| Outcome | Meaning | What to do |
|---|---|---|
| `PASSED` | Promoted with a receipt | Review the batch commit, then `integrate` or `land` |
| `FAILED` | Deterministic failure: scope violation, or nothing to integrate | Fix the task or the change |
| `ESCALATED` | Needs a person: repair budget exhausted, reviewer escalated, policy violation, integrity failure | Read the reason and the findings in `report.json` |
| `PAUSED` | Usage limit, or waiting at a human gate | `panagent resume <run-id>` (add `--decision` for a gate) |
| `ERROR` | Infrastructure, provider, or config failure after retries | Read `error` in `run.json`; rerun when fixed |

A paused run keeps its candidate directory and its batch ref reservation. Resuming re-enters the
stage that paused, with all earlier evidence.

## Events

`events.jsonl` has one JSON object per line with `at` and `type`. Types include `run.started`,
`stage.started`, `stage.completed`, `agent.started`, `agent.finished`, `agent.retry`,
`check.finished`, `verification.finished`, `review.finished`, `budget.spent`,
`promotion.finished`, `receipt.written`, `run.paused`, `run.resumed`, `stage.failed`, and
`run.finished`. The log is the input for dashboards and a future UI: a UI reads it and calls the
CLI; it never changes run state itself.

## Metrics

```bash
panagent metrics              # all runs in this repository's run store, all receipts
panagent metrics --ref main   # receipts only on commits reachable from main
panagent metrics --json       # includes the definitions below
```

Two views, kept apart on purpose:

- **Runs** count every run, including failures. `first_attempt_pass_rate` is task runs that
  passed with zero repairs over all finished task runs. `harness_error_rate` is runs that ended
  in `ERROR` over all finished runs.
- **Deliveries** come from receipts, so they only cover work that passed. An integration is a
  receipt on a merge commit (two parents); it is counted separately because merges rarely need
  repair and would inflate repair-free rates.

Reporting only the delivery view overstates success, since a task that never passes leaves no
receipt. Publish both, with their definitions and date range.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR` with `infra/dependencies_missing` | `node_modules` not installed in the source checkout | `npm ci` in the check's `cwd` |
| `ERROR` with `infra/dependency_contract` | Source checkout's `package.json` or lock differs from the base | Sync the checkout with the base commit |
| Check `fail` with `integrity/dependency_contract` | The candidate changed `package.json` or the lock | Dependency changes need a person; do them outside the agent run |
| Check `infra_error` with `timeout` | Slow machine or hung test | Raise `timeout_ms`, or stop other heavy processes |
| A check fails only under the sandbox | It needs network, a denied path, or a write outside its tree | Set `network: true` for that check, or point caches at `HOME`/`TMPDIR` |
| `PAUSED` with "usage limit reached" | The runtime's plan limit | `panagent resume <run-id>` after the reset time |
| `ESCALATED` with `policy_violation` | The runtime used a capability outside the harness | Run `panagent doctor --live`; update the adapter's disable list |
| `land` refuses with "no valid receipt" | A commit between target and source was not promoted by a run | Integrate it through `panagent integrate`, or land up to the last receipted commit |
| `repository is locked by pid ...` | Another Panagent process holds the lock | Wait; a dead owner's lock is recovered automatically |
