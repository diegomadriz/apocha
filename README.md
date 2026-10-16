# Apocha

Apocha runs coding agents under a deterministic controller that decides whether their work is
accepted.

Each task names the paths an agent may change and the checks it must pass. An implementer agent
edits a private copy of the repository through a small set of scoped tools. The task's checks run
in an OS sandbox. A separate reviewer agent judges the verified change. If the review passes, the
controller commits the change to a batch branch and attaches a receipt to the commit as a Git note.
`apocha land` fast-forwards a branch only when every new commit carries a receipt that matches its content. Receipts can be signed with an SSH key. With `land --require-signed`, or `receipts.require_signed` in the config, only receipts signed by a key listed in the repository's allowed signers file are accepted. That file is read from the target branch.

It works with Codex CLI, Claude Code, and Pi as agent runtimes, chosen per role in a config file.

```text
task.json ─► candidate (private clone at the base commit)
                │
                ▼
   implement ── agent with harness tools only (read, search, apply_patch, run_check, submit_result)
                │
                ▼
   verify ───── scope and protected-path checks, then the task's named checks in a sandbox
                │            fail ─► repair (bounded) ─► implement
                ▼
   review ───── independent agent, read-only, sees the full diff, bound to the candidate digest
                │            FIX ─► repair      ESCALATE ─► human
                ▼
   promote ──── commit onto refs/heads/<prefix>/batch/<name> + receipt (git note)
                │
                ▼
   land ─────── fast-forward a branch if every first-parent commit has a valid receipt (never pushes)
```

## What it guarantees

- **Agents cannot change what judges them.** Checks come from a closed catalog in `apocha.config.json`.
  A task can name check IDs but cannot supply commands. Agents cannot edit the config, the checks,
  or any protected path.
- **Agents cannot quietly rewrite existing tests.** By default an agent may add tests and add
  lines to existing test files, but not change or remove existing test lines. A task can allow
  more, and the reviewer then sees every changed test. Tests a change adds or modifies are also
  run against the old code, and the result is recorded in the receipt. Added lines can still
  change how a test runs, so the reviewer remains the check on those.
- **Agents act only through the harness tools.** No shell, no runtime built-in tools, no
  connectors. Each adapter disables its runtime's own capabilities and fails the run if the
  runtime uses one anyway. `apocha doctor --live` asks each runtime to escape and reports
  whether it could.
- **Untrusted code runs sandboxed.** Checks execute code an agent may have written, so they run
  in a fresh copy of the tree (no `.git`, no untracked files, no forbidden paths) under Linux bubblewrap or macOS Seatbelt: no writes outside the workspace and no reads of credential stores or secret files in the checkout. Both give the check a read-only view of the rest of the host and no network access. On macOS the profile is deny-by-default, so the check also cannot reach local services or daemon sockets. On Linux, bubblewrap removes the network but cannot block every local socket: Apocha hides Docker's socket, the desktop session bus, X11, the SSH agent, and common database sockets, and any other socket on the filesystem stays reachable. A check that needs to listen on and connect to loopback, such as a bundler with worker processes, opts in with `loopback: true`.
- **Evidence is bound to content.** The candidate is identified by a SHA-256 over its base and
  full diff, rechecked after checks, after review, and before promotion. A receipt records that
  digest with the check definitions, configuration, prompts, and runtimes used, and
  `apocha receipt` recomputes the digest from Git.
- **Every run is recorded.** Failed, escalated, and errored runs stay in the run store with their
  event log, so metrics have an honest denominator.
- **It cleans up after itself.** Temporary clones and workspaces are removed when a run ends. `land` deletes the batch branches it landed, and `apocha gc` removes anything left from crashed runs. Each deletion is logged with the commit id needed to restore it.

## What it does not do

- It does not sandbox the agent runtime process itself. The runtime needs your sign-in and the
  network to reach its model; Apocha keeps the model's actions inside the harness tools, and
  Codex additionally runs with its own read-only sandbox. Run Apocha in a container or VM if
  the repository or the task text could be hostile.
- A check marked `unsandboxed: true` in the project config runs without an OS sandbox. A run that uses one needs `--allow-governance-edits` with a reason, and agents cannot run it themselves through `run_check`.
- Signing is opt-in. Without `--require-signed`, `land` checks that each receipt matches its commit, but not who wrote it.
- A repository's own `.apocha/runtimes.json` is ignored unless you pass `--trust-repo-runtimes`, because it decides which program runs.
- It does not push, open pull requests, or deploy.

## Quickstart

Requirements: Node 22 or newer, Git, and at least one runtime CLI signed in (`codex`, `claude`,
or `pi`).

```bash
git clone https://github.com/diegomadriz/apocha.git
cd apocha && npm install && npm install -g .
```

In the repository you want agents to work on:

```bash
apocha init          # writes apocha.config.json from package.json or pyproject.toml
```

Choose runtimes in `~/.config/apocha/runtimes.json` (or `.apocha/runtimes.json` in the repo
when you pass `--trust-repo-runtimes`):

```json
{
  "version": 1,
  "roles": {
    "implementer": { "adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium" },
    "reviewer": { "adapter": "claude-code", "model": "claude-sonnet-5-5", "effort": "high" }
  }
}
```

Then:

```bash
apocha doctor --live
apocha run task.json --base main --batch my-task --message "Describe the change"
apocha land apocha/batch/my-task --target main
```

A task looks like this (`examples/toy-node/tasks/slugify-accents.json`):

```json
{
  "task_id": "slugify-accents",
  "description": "Make slugify strip accents, drop punctuation, and collapse separators. Add tests.",
  "acceptance_criteria": ["slugify(\"Crème Brûlée Recipe\") returns \"creme-brulee-recipe\""],
  "allowed_paths": ["src/", "test/"],
  "checks": ["test"],
  "max_repair_attempts": 2
}
```

To try it without a model, run the test suite: it drives full runs with a scripted fake runtime.

## Commands

| Command | Purpose |
|---|---|
| `apocha init` | Write a starter `apocha.config.json` |
| `apocha doctor [--live]` | Check git, config, sandbox, and runtimes; `--live` probes each runtime's lock-down |
| `apocha validate <task.json>` | Validate a task against the schema and the project config |
| `apocha run <task.json> --base <ref> --batch <name> (--message <text> \| --message-file <path>)` | Run the code-delivery workflow |
| `apocha integrate <topic> --onto <ref> --batch <name>` | Merge a topic, verify and review the merged tree, promote it |
| `apocha land <source> --target <branch> [--keep-batch] [--require-signed]` | Fast-forward a branch whose new commits all carry valid receipts (signed, if required), then delete the landed batch branches |
| `apocha unlock [--force]` | Recover a stale lock after confirming no command is running; refuses live owners unless forced |
| `apocha receipt <commit>` | Verify and print a receipt |
| `apocha verify-range <base>..<head> [--require-signed]` | Check that every commit in a range carries a valid receipt; used by the GitHub Action |
| `apocha runs`, `apocha show <run-id> [--events]` | Run history and the event log of one run |
| `apocha resume <run-id> [--decision approve\|reject]` | Resume a run paused by a usage limit or a human gate |
| `apocha metrics [--ref <ref>]` | Outcomes over all runs, and delivery statistics from receipts |
| `apocha status [--json]` | Where things stand: batches and their receipts, runs that need attention, a commit graph, disk use, next steps |
| `apocha gc [--apply]` | Preview, then remove merged batch branches, leftover temp directories, and old session traces |
| `apocha analytics [--since] [--json\|--format md]` | Run analytics: outcomes, repairs, review, runtimes, tool use, durations |

Exit codes: `0` passed, `2` usage or config error, `10` paused, `20` not passed, `30` error.

## In pull requests

The repository includes a GitHub Action that verifies the receipts of every commit in a pull request (and their signatures, if required) without running any agent. Use it as a required status check. See [docs/github-action.md](docs/github-action.md).

## Documentation

- [Architecture](docs/architecture.md): the controller, the engine, and the invariants it enforces
- [Configuration](docs/configuration.md): project config, runtime config, and task manifests
- [Adapters](docs/adapters.md): how each runtime is locked down, and how to add one
- [Workflows](docs/workflows.md): workflows as data, stage kinds, and adding a workflow
- [Receipts](docs/receipts.md): what a receipt proves and how `land` uses it
- [Security](docs/security.md): threat model, sandbox policy, and known gaps
- [Operations](docs/operations.md): runs, pause and resume, metrics, and troubleshooting
- [AGENTS.md](AGENTS.md): how to work on this repository

## License

MIT
