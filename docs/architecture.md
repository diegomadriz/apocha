# Architecture

Apocha is a controller around agent runtimes. The controller owns every decision that matters
(state, verification, acceptance, promotion). Agents are workers that can only act through tools
the controller provides.

## Components

```text
bin/apocha.mjs ─► src/cli/            commands, progress output, exit codes
                     │
                     ▼
                    src/core/run.mjs     run lifecycle: inputs, batch ref, candidate, finalize
                     │
                     ▼
                    src/core/engine.mjs  runs a workflow definition stage by stage
                     │
       ┌─────────────┼──────────────┬──────────────┬──────────────┐
       ▼             ▼              ▼              ▼              ▼
  stages/agent   stages/checks  stages/review  stages/promote  stages/seed, budget, human
       │             │              │              │
       ▼             ▼              ▼              ▼
  adapters/      checks/runner   adapters/      git/promotion
  (codex,        sandbox/        (same)         git/receipts
   claude-code,                                 git/land
   pi, fake)
       │
       ▼
  tools/ (served over MCP or a Pi extension; the agent's only way to act)
```

| Directory | Responsibility |
|---|---|
| `src/config/` | Load and validate `apocha.config.json`, runtime configs, and task manifests against `schemas/` |
| `src/core/` | Workflow validation, the engine, run lifecycle, run store and events, lock, metrics |
| `src/core/gc.mjs` | Plan and apply cleanup of merged batch refs, orphan temp directories, and old session traces |
| `src/core/status.mjs` | Read-only repository inventory and human status formatting |
| `src/util/temp.mjs` | Owned temp directories, owner markers, and temp inventory |
| `src/workflows/` | Built-in workflow definitions (data) |
| `src/stages/` | One implementation per stage kind |
| `src/tools/` | The harness tools (read, search, patch, run_check, submit_result) and their definitions |
| `src/adapters/` | One adapter per agent runtime, the MCP tool server, and process handling |
| `src/checks/` | Running a catalog check in a fresh tree, and dependency policies |
| `src/sandbox/` | Seatbelt and bubblewrap wrappers |
| `src/git/` | Candidates, promotion, receipts, land |
| `src/util/` | Errors, git, digests, bounded text, safe file access, the schema validator |
| `src/prompts/` | Role prompts, hashed into every receipt |

## The run lifecycle

1. **Resolve inputs.** The base ref resolves to a commit. The project config is read **from the
   base commit**, so a candidate can never change the rules it is judged by. The task is
   validated against the schema and that config.
2. **Reserve the batch ref.** `refs/heads/<batch_prefix><name>` is created at the base commit
   with a compare-and-swap from "absent", under the repository lock. A second run cannot take the
   same name.
3. **Create the candidate.** A no-hardlink clone of the repository, detached at the base commit,
   with its remote removed.
4. **Run the workflow.** The engine runs stages until a terminal state or a pause.
5. **Finalize.** Write the report and the final run record; release the batch ref unless the run
   passed or paused; remove the candidate unless the run paused.

## The engine

A workflow is a data object: a start stage and a table of stages. Each stage has a `kind` and an
`on` map from outcome to the next stage or a terminal state (`PASSED`, `FAILED`, `ESCALATED`).
See [workflows.md](workflows.md).

The engine is the only code that changes the current stage. A stage returns an outcome string; the
engine looks it up in the stage's `on` map. After every transition it appends an event to the run's
`events.jsonl` and persists the run state, so a paused run can resume at the stage it paused in.

Errors map to outcomes in one place (`src/core/engine.mjs`):

| Error class | Run outcome | Why |
|---|---|---|
| `usage_limited` | `PAUSED` | Subscription or rate limits pass; the run resumes later |
| human gate without a decision | `PAUSED` | Waits for `apocha resume --decision` |
| `agent`, `integrity`, `policy_violation` | `ESCALATED` | A person should look at what the agent did |
| `config`, `infra`, `provider`, `tool_protocol` | `ERROR` | The harness or its environment failed |

`infra`, `provider`, and `tool_protocol` errors from a runtime are retried once (configurable)
before they become an outcome. So is an agent run that made no tool calls and submitted nothing.
Every retry is counted in the run record and the receipt.

## Invariants

These hold in code, and the tests exercise each one.

1. **Only the controller moves state.** Agent output is data: a validated result object. Agent
   prose never advances a run.
2. **Agents act only through harness tools.** Tools are confined to the candidate and to the
   task's scopes. Writes need an allowed, unprotected path. Forbidden paths are never readable.
   Symlinks are refused.
3. **The judge is out of reach.** Check commands live in the project config, which is read from
   the base commit and is always a governance path. Tasks name check IDs only.
4. **Evidence is bound to content.** The candidate digest is
   `sha256({ base_commit, changed_files, diff })`. Verification, review, and promotion each
   re-snapshot the candidate and refuse to continue if the digest changed.
5. **Structural checks come first.** Every changed file must be inside `allowed_paths` and
   outside every protected path. A change smuggled past the tools fails here.
6. **Infra errors outrank passes.** One check with an infrastructure error makes the whole
   verification an infrastructure error.
7. **Review is independent and bound.** The reviewer runs in a fresh process with read-only
   tools, sees the full diff, and must echo the candidate digest it reviewed. A diff larger than
   the configured limit escalates; it is never truncated.
8. **Repairs are bounded.** At most two repair rounds per run (per task, configurable lower).
9. **Promotion is atomic.** The batch ref moves from the base to the promoted commit with a
   compare-and-swap, under the repository lock, and the receipt is written in the same critical
   section.
10. **Land never pushes**, and refuses any first-parent commit without a valid receipt.

## Agent bundles

The implementer receives the task, acceptance criteria, scopes, the names of its checks, any
findings to address (failure lines first for failed checks), a short history of earlier failures,
the files named in `initial_context`, and the design references (read from the base commit).

The reviewer receives the task, acceptance criteria, the candidate's changed and deleted files,
the full diff, the check results, the implementer's summary, and the design references.

Both get role prompts from `src/prompts/`. The prompts, the tool definitions and limits, the
workflow, and the package version are hashed into `policy_digest` in every receipt.

## State on disk

```text
<git-common-dir>/apocha/
  lock                        held around ref mutations and land
  runs/<run-id>/
    run.json                  metadata and current state (atomic rewrite)
    events.jsonl              append-only history
    report.json               final summary and state
    verification-NN.json      full check output for each verification
    sessions/NNN/             one directory per agent invocation
      session.json            the tool policy given to the tool server
      tools.jsonl             one line per tool call (paths, never contents)
      result.json             the submitted result
```

Nothing here is committed. Receipts (Git notes) are the only durable evidence that travels with
the repository.
