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
| Seatbelt | macOS (`/usr/bin/sandbox-exec`) | Writes only in the check workspace (its tree, scratch `HOME`, and `TMPDIR`). Reads denied for credential stores, the candidate clone, the source `.git`, and forbidden paths. Deny by default, with explicit process and system-service allows. Broad toolchain reads remain intentional. DNS, host loopback and outside Unix sockets are denied unless network is allowed; `loopback: true` permits loopback only. For headless Chromium checks, `browser: true` allows registration and lookup of `org.chromium.*` Mach services only; it implies no loopback, network or other allow. Browsers usually also need loopback for a local test server. Workspace Unix sockets work. Listed local daemon sockets stay denied. |
| bubblewrap | Linux | Read-only view of the host root, writable workspace, read-only tmpfs (`--tmpfs` followed by `--remount-ro`) over denied directories, read-only `/dev/null` over denied files, `--unshare-net` unless the check allows network, `--unshare-pid`, `--die-with-parent` |
| none | anywhere | Scratch `HOME` and `TMPDIR` and the env allowlist still apply. Recorded as `none` in the receipt. Set `sandbox.mode: "required"` to refuse running without a backend. |

A catalog check can set `unsandboxed: true` to skip the OS sandbox even when
`sandbox.mode` is `required`. Agent-written code executed by that check runs without
an OS sandbox: host read, write, network, and socket restrictions are not enforced.
The fresh workspace, scratch `HOME` and `TMPDIR`, environment allowlist, and source-secret
discovery still apply, but discovery alone cannot block host reads. Neither
`APOCHA_SANDBOX` nor `PANAGENT_SANDBOX` is set. Results and receipts record `sandbox: "none"`;
every run warns by check name, and doctor lists opted-out checks.

This is a governance-controlled choice in the base commit's closed catalog, not an
option an agent or task can supply. Apocha's `sandbox-selftest` uses it because macOS
cannot nest Seatbelt profiles: without the opt-out, the real-sandbox tests see the
outer sandbox markers and skip. Selection rules run it for sandbox and check-runner
code or the real-sandbox test files, rather than as a default check.

Runs selecting any catalog check marked `unsandboxed: true` require explicit approval via
`--allow-governance-edits` with a non-empty `--reason`, whether the task names the check
or selection rules add it. Without approval, startup refuses and names the checks.
The implementer's `run_check` tool never runs these checks and its available-check list
excludes them. Only the controller runs them during verification, after structural checks pass.

Every path those self-test selection rules select on is also a governance path in Apocha's
own config. Projects using `unsandboxed: true` should follow the same pattern.

The default deny list covers `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`,
`~/.codex`, `~/.claude`, `~/.pi`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker`,
`~/.kube`, `~/.git-credentials`, and `~/Library/Keychains`. Add more with `sandbox.deny_read`.

Sandboxed checks also deny reads of untracked files in the source checkout, including ignored
files, whose basenames match `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, or
`id_ed25519*`, at any depth (for example `apps/web/.env.local`). Tracked files are excluded
from this discovery. `apocha doctor` reports the count and relative paths of the files found.
Discovery is cached once per run per source root, including across repair attempts.
This default applies to both Seatbelt and bubblewrap; without an OS sandbox it cannot block reads.
The configured runtime receipt signing key and its `.pub` file, including canonical paths,
are always added to sandboxed checks' read deny lists.

Local daemon sockets are denied independently of the network setting. The defaults are
`/var/run/docker.sock`, `/run/docker.sock`, `~/.docker/run/docker.sock`,
`~/.colima/default/docker.sock`, `~/.orbstack/run/docker.sock`,
`/run/containerd/containerd.sock`, `/run/podman/podman.sock`, and
`~/.local/share/containers/podman/machine/podman.sock`. Add paths with
`sandbox.deny_sockets`; additions cannot remove the defaults. Home paths are expanded,
and existing symlink targets are also denied. Seatbelt denies outbound connections to
these paths; bubblewrap hides existing canonical paths with read-only `/dev/null` bindings.
Absent paths are omitted, and canonical mount targets avoid symlink mount-point failures
on bubblewrap versions before 0.12.

Bubblewrap also hides existing desktop and daemon socket directories with read-only tmpfs:
`/run/user/<current uid>`, `/tmp/.X11-unix`, `/run/dbus`, `/var/run/postgresql`
(canonical `/run/postgresql`), `/run/mysqld`, and the directory containing
`$SSH_AUTH_SOCK` when set. It never hides `/`, the OS temporary directory itself,
or a directory that is or contains a writable path. Filesystem Unix sockets outside
these hidden directories and the configured deny lists stay reachable on bubblewrap,
even with network disabled; network namespaces do not isolate filesystem Unix sockets.
Without an OS sandbox these socket restrictions cannot be enforced.

Seatbelt starts from `(deny default)` when network is denied. It explicitly permits process
execution, self introspection, sysctl reads, and logging, notification and user/group lookup
services. It grants no DNS or network-configuration service access. Reads remain broad for
host toolchains, with the deny lists overriding them; metadata reads remain available everywhere.
Writes stay confined to the workspace and `/dev/tty`, `/dev/null`, `/dev/zero`, and `/dev/fd/*`.
Other terminals (`/dev/ttys*`) and pseudo-terminals (`/dev/pty*`, `/dev/ptmx`) are denied. Unix sockets inside the
workspace support tool IPC. `checks.<id>.loopback: true` allows loopback binding, listening and
connections, including access to host loopback services. Use it only for checks that need this.
On bubblewrap the option is accepted as a no-op: loopback is inside its isolated network namespace.
Set `checks.<id>.browser: true` only for checks that run headless Chromium. Seatbelt then
allows `mach-register` and `mach-lookup` for the `org.chromium.` global name prefix.
This adds no other allow and implies neither loopback nor network; it is a no-op on
bubblewrap and adds nothing when network is already allowed. Browsers usually also need
`loopback: true` to load pages from a local test server. Checks get a scratch `HOME`,
so set `PLAYWRIGHT_BROWSERS_PATH` in the check's `env` for Playwright's installed browsers.
Use a portable installation path; do not commit an absolute home path to the repository.
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
- **Agents can still write weak tests.** The `test_edits` policy governs existing tests:
  `new-files` forbids changes to them, `additive` permits additions but rejects removed lines
  and deletions, and `allowed` permits edits. The reviewer is instructed to flag weakened
  or special-cased tests. For high-stakes tasks,
  protect the test directory and put new tests in a separate task.

## Prompt injection

Repository files are untrusted input to the agent. The design limits the damage an injected
instruction can do: the agent cannot run commands, cannot read forbidden paths or credentials,
cannot change the checks, and cannot accept its own work. Linux bubblewrap removes network access from checks unless a check allows it. On macOS, Seatbelt denies network and DNS services by default; checks can opt into loopback. The remaining exposure is that the
model sends readable repository content to its provider, which is inherent to using a hosted model
on that repository.
