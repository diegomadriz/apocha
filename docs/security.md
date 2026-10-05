# Security

## Threat model

Panagent assumes the **agent is untrusted**: it may be wrong, may game its checks, and may follow
instructions planted in repository files. It assumes the **operator, the project config at the
base commit, and the runtime CLIs are trusted**.

| Asset | Threat | Control |
|---|---|---|
| The verdict | Agent edits tests, checks, or config to pass | Closed check catalog in the config read from the base commit; config, `.panagent/`, and governance paths are protected; tasks cannot supply commands; structural checks before any catalog check |
| The repository outside the task | Agent edits files it should not | Tool scopes (`allowed_paths`), protected paths, structural scope check on the final diff |
| Private files in the repository | Agent reads and leaks them through output or a model call | `paths.forbidden` are unreadable by tools, removed from the tree checks run in, and denied to sandboxed checks in the source checkout |
| Credentials on the host | Agent-written code (run by checks) reads them | Sandbox deny list for credential stores; scratch `HOME`; env allowlist without provider keys |
| The host | Agent-written code writes outside its tree or calls out | Sandbox: writes only in the per-check workspace; network denied unless a check allows it |
| History | Unverified commits reach a branch | Receipts bound to content; `land` checks every first-parent commit; promotion by compare-and-swap |

## Where untrusted code runs

**Agents have no exec.** Every runtime is started with its own tools disabled, and the adapter
fails the run if the runtime uses anything but the harness tools (see
[adapters.md](adapters.md)). The harness tools read, search, and patch files inside the candidate,
and run catalog checks.

**Checks run agent-written code.** A test file the agent added is executed by `npm test` or
`pytest`. So checks, and `run_check`, run in a fresh directory built from the candidate's Git
index (no `.git`, no untracked or ignored files, no forbidden paths), under an OS sandbox:

| Backend | Platform | Policy |
|---|---|---|
| Seatbelt | macOS (`/usr/bin/sandbox-exec`) | Writes only in the check workspace and per-user temp. Reads denied for credential stores, the candidate clone, the source `.git`, and forbidden paths. Outbound network only to loopback; listening only on loopback. |
| bubblewrap | Linux | Read-only root, writable workspace, tmpfs over denied directories, `--unshare-net` unless the check allows network, `--unshare-pid`, `--die-with-parent` |
| none | anywhere | Scratch `HOME` and `TMPDIR` and the env allowlist still apply. Recorded as `none` in the receipt. Set `sandbox.mode: "required"` to refuse running without a backend. |

The default deny list covers `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`,
`~/.codex`, `~/.claude`, `~/.pi`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker`,
`~/.kube`, `~/.git-credentials`, and `~/Library/Keychains`. Add more with `sandbox.deny_read`.

## Known gaps

- **The runtime process is not sandboxed by Panagent.** Codex, Claude Code, and Pi need your
  sign-in and the network to reach their models. Panagent limits what the *model* can do inside
  them, and Codex adds its own read-only OS sandbox. If the repository or task text could be
  hostile, run Panagent inside a container or VM.
- **Lock-down depends on runtime flags.** A runtime update can add a capability that is on by
  default. The stream checks catch the use of anything outside the harness tools, but only after
  the fact. Run `panagent doctor --live` after every runtime upgrade.
- **Reads are a denylist, not an allowlist.** Sandboxed checks can read the rest of the host
  filesystem (toolchains live there). Keep secrets in the denied locations or add their paths.
- **Receipts are unsigned.** See [receipts.md](receipts.md#limits).
- **Agents can still write weak tests.** Protected paths keep existing tests safe when you protect
  them; the reviewer is instructed to flag weakened or special-cased tests. For high-stakes tasks,
  protect the test directory and put new tests in a separate task.

## Prompt injection

Repository files are untrusted input to the agent. The design limits the damage an injected
instruction can do: the agent cannot run commands, cannot reach the network, cannot read forbidden
paths or credentials, cannot change the checks, and cannot accept its own work. The remaining
exposure is that the model sends readable repository content to its provider, which is inherent to
using a hosted model on that repository.
