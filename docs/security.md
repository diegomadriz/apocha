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
| The host | Agent-written code writes outside its tree or calls out | Sandbox: writes only in the per-check workspace; Linux removes network access unless a check allows it; macOS denies outbound network but DNS and loopback services remain reachable |
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
| Seatbelt | macOS (`/usr/bin/sandbox-exec`) | Writes only in the check workspace (its tree, scratch `HOME`, and `TMPDIR`). Reads denied for credential stores, the candidate clone, the source `.git`, and forbidden paths. Outbound network denied, but DNS, loopback services, and local Unix sockets such as Docker's remain reachable. The profile allows everything else by default. |
| bubblewrap | Linux | Read-only view of the host root, writable workspace, tmpfs over denied directories, read-only `/dev/null` over denied files, `--unshare-net` unless the check allows network, `--unshare-pid`, `--die-with-parent` |
| none | anywhere | Scratch `HOME` and `TMPDIR` and the env allowlist still apply. Recorded as `none` in the receipt. Set `sandbox.mode: "required"` to refuse running without a backend. |

The default deny list covers `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`,
`~/.codex`, `~/.claude`, `~/.pi`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker`,
`~/.kube`, `~/.git-credentials`, and `~/Library/Keychains`. Add more with `sandbox.deny_read`.

Sandboxed checks also deny reads of untracked files in the source checkout, including ignored
files, whose basenames match `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, or
`id_ed25519*`, at any depth (for example `apps/web/.env.local`). Tracked files are excluded
from this discovery. `panagent doctor` reports the count and relative paths of the files found.
This default applies to both Seatbelt and bubblewrap; without an OS sandbox it cannot block reads.

## Known gaps

- **The runtime process is not sandboxed by Panagent.** Codex, Claude Code, and Pi need your
  sign-in and the network to reach their models. Panagent limits what the *model* can do inside
  them, and Codex adds its own read-only OS sandbox. If the repository or task text could be
  hostile, run Panagent inside a container or VM.
- **Lock-down depends on runtime flags.** A runtime update can add a capability that is on by
  default. The stream checks catch the use of anything outside the harness tools, but only after
  the fact. Run `panagent doctor --live` after every runtime upgrade.
- **Seatbelt allows by default and denies listed operations.** On macOS, checks can read the
  rest of the host filesystem (toolchains live there). The profile denies outbound network and
  listed paths, but DNS, loopback services, and the Docker socket remain reachable. Keep secrets
  in the denied locations or add their paths. Linux bubblewrap gives a read-only view of the host too, but removes network access entirely. On both backends a local Unix socket such as Docker's may be reachable; add its path to sandbox.deny_read if checks must not use it.
- **Receipts are unsigned.** Anyone with write access to the repository can forge a note that
  `land` will accept. Signing is planned. See [receipts.md](receipts.md#limits).
- **Repository-level runtime config requires explicit trust.** `.panagent/runtimes.json` chooses
  runtime commands and is ignored unless you pass `--trust-repo-runtimes`. It is a governance
  path, so agents cannot change it, but a person who can commit to the repository can.
- **The bubblewrap backend has unit tests for its arguments but has not yet been exercised on a
  Linux host in this project's own testing.** The CI workflow installs bubblewrap and enables
  unprivileged user namespaces so the sandbox tests run there.
- **Agents can still write weak tests.** Protected paths keep existing tests safe when you protect
  them; the reviewer is instructed to flag weakened or special-cased tests. For high-stakes tasks,
  protect the test directory and put new tests in a separate task.

## Prompt injection

Repository files are untrusted input to the agent. The design limits the damage an injected
instruction can do: the agent cannot run commands, cannot read forbidden paths or credentials,
cannot change the checks, and cannot accept its own work. Linux bubblewrap removes network access from checks unless a check allows it. On macOS, Seatbelt denies outbound network but DNS and loopback services remain reachable. The remaining exposure is that the
model sends readable repository content to its provider, which is inherent to using a hosted model
on that repository.
