# Security

## Threat model

Apocha assumes the **agent is untrusted**: it may be wrong, may game its checks, and may follow
instructions planted in repository files. It assumes the **operator, the project config at the
base commit, and the runtime CLIs are trusted**.

| Asset | Threat | Control |
|---|---|---|
| The verdict | Agent edits tests, checks, or config to pass | Closed check catalog in the config read from the base commit; config, `.apocha/`, and governance paths are protected; tasks cannot supply commands; structural checks before any catalog check |
| The repository outside the task | Agent edits files it should not | Tool scopes (`allowed_paths`), protected paths, structural scope check on the final diff |
| Private files in the repository | Agent reads and leaks them through output or a model call | `paths.forbidden` are unreadable by tools, removed from the tree checks run in, and denied to sandboxed checks in the source checkout |
| Credentials on the host | Agent-written code (run by checks) reads them | Sandbox deny list for credential stores; scratch `HOME`; env allowlist without provider keys |
| The host | Agent-written code writes outside its tree or calls out | Sandbox: writes only in the per-check workspace; network denied unless a check allows it; macOS loopback requires explicit opt-in |
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
| Seatbelt | macOS (`/usr/bin/sandbox-exec`) | Writes only in the check workspace (its tree, scratch `HOME`, and `TMPDIR`). Reads denied for credential stores, the candidate clone, the source `.git`, and forbidden paths. Deny by default, with explicit process and system-service allows. Broad toolchain reads remain intentional. DNS, host loopback and outside Unix sockets are denied unless network is allowed; `loopback: true` permits loopback only. Workspace Unix sockets work. Listed local daemon sockets stay denied. |
| bubblewrap | Linux | Read-only view of the host root, writable workspace, tmpfs over denied directories, read-only `/dev/null` over denied files, `--unshare-net` unless the check allows network, `--unshare-pid`, `--die-with-parent` |
| none | anywhere | Scratch `HOME` and `TMPDIR` and the env allowlist still apply. Recorded as `none` in the receipt. Set `sandbox.mode: "required"` to refuse running without a backend. |

The default deny list covers `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`,
`~/.codex`, `~/.claude`, `~/.pi`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker`,
`~/.kube`, `~/.git-credentials`, and `~/Library/Keychains`. Add more with `sandbox.deny_read`.

Sandboxed checks also deny reads of untracked files in the source checkout, including ignored
files, whose basenames match `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, or
`id_ed25519*`, at any depth (for example `apps/web/.env.local`). Tracked files are excluded
from this discovery. `apocha doctor` reports the count and relative paths of the files found.
Discovery is cached once per run per source root, including across repair attempts.
This default applies to both Seatbelt and bubblewrap; without an OS sandbox it cannot block reads.

Local daemon sockets are denied independently of the network setting. The defaults are
`/var/run/docker.sock`, `/run/docker.sock`, `~/.docker/run/docker.sock`,
`~/.colima/default/docker.sock`, `~/.orbstack/run/docker.sock`,
`/run/containerd/containerd.sock`, `/run/podman/podman.sock`, and
`~/.local/share/containers/podman/machine/podman.sock`. Add paths with
`sandbox.deny_sockets`; additions cannot remove the defaults. Home paths are expanded,
and existing symlink targets are also denied. Seatbelt denies outbound connections to
these paths; bubblewrap hides existing paths with read-only `/dev/null` bindings.
Without an OS sandbox these socket restrictions cannot be enforced.

Seatbelt starts from `(deny default)` when network is denied. It explicitly permits process
execution, self introspection, sysctl reads, and logging, notification and user/group lookup
services. It grants no DNS or network-configuration service access. Reads remain broad for
host toolchains, with the deny lists overriding them; metadata reads remain available everywhere.
Writes stay confined to the workspace and standard device streams. Unix sockets inside the
workspace support tool IPC. `checks.<id>.loopback: true` allows loopback binding, listening and
connections, including access to host loopback services. Use it only for checks that need this.
On bubblewrap the option is accepted as a no-op: loopback is inside its isolated network namespace.
Enabling network retains the previous permissive service policy, with read, write and socket
restrictions still enforced.

## Known gaps

- **The runtime process is not sandboxed by Apocha.** Codex, Claude Code, and Pi need your
  sign-in and the network to reach their models. Apocha limits what the *model* can do inside
  them, and Codex adds its own read-only OS sandbox. If the repository or task text could be
  hostile, run Apocha inside a container or VM.
- **Lock-down depends on runtime flags.** A runtime update can add a capability that is on by
  default. The stream checks catch the use of anything outside the harness tools, but only after
  the fact. Run `apocha doctor --live` after every runtime upgrade.
- **Unsigned receipts remain forgeable when signatures are optional.** Require signatures
  with `land --require-signed` or target config `receipts.require_signed` to close this gap.
  Trust comes from the target branch's allowed_signers file, a governance path. Protect
  signing keys outside the repository; signatures attest the operator's key, not the truth
  of the recorded checks. See [receipts.md](receipts.md#limits).
- **Repository-level runtime config requires explicit trust.** `.apocha/runtimes.json` chooses
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
cannot change the checks, and cannot accept its own work. Linux bubblewrap removes network access from checks unless a check allows it. On macOS, Seatbelt denies network and DNS services by default; checks can opt into loopback. The remaining exposure is that the
model sends readable repository content to its provider, which is inherent to using a hosted model
on that repository.
