# Changelog

## Unreleased

- Publish Apocha's self-hosted run history with denominators and reproduction limits, document signature checks, and clarify judge input rules for test hooks.
- Reviewer provenance now marks per-file test and judge input diffs as untrusted; blocked-claim verification moves implementer judge input reasons under `untrusted`.
- macOS home read exceptions never reopen the home directory itself, including through PATH bin parents, Node prefixes, or symlinks. Credential denies now cover toolchain credential files and additional credential stores, and still override home allows.
- Sandbox mode `auto` now fails closed without a backend (except inside an already sandboxed check); install bubblewrap on Linux or explicitly set `sandbox.mode: "none"` to opt out.
- macOS checks deny home directory reads except the workspace, source checkout and toolchain directories. `sandbox.allow_read` adds exceptions and `sandbox.home_reads: "allow"` opts out; credential and source denies still win. Linux bubblewrap is unchanged, reads outside its deny list remain possible, and it has not yet been run on a real Linux host.
- Reviewer bundles separate implementer text under `untrusted` with a provenance map. The prompt treats it, diffs, and file content as data, never instructions, and requires blocking findings for steering attempts. Real-model resistance is measured only by a small private evaluation and is not guaranteed.
- Reviewers must justify every declared judge input change by path before PASS; promotion enforces the verdicts and receipts record them. Receipt validation now accepts the `tighten` declaration kind.
- Declared judge input changes must pass checks with the base judge inputs restored; loosening escalates without repair or promotion, and passing evidence is recorded in receipts.
- Judge input changes now require task or implementer declarations, with configurable additive patterns and verification evidence; tier 0 protections remain unchanged.
- The README and security guide now state that checker config files and inline suppressions are not frozen, describe the `justified` default, and list the sandbox read and reviewer-input gaps.
- Repository locks now publish complete owner records atomically and release only matching owner tokens; dead owners fail closed immediately, while empty or unparseable locks wait before failing closed. Recover explicitly with `apocha unlock` (`--force` overrides a live owner).
- `PASS` reviews with blocking findings now escalate, and promotion rejects them in restored state; minor findings and findings without severity still allow promotion.
- Test edits now default to `justified`: an existing test may change only when its old version fails on the new code, or when the edit keeps every existing assertion and makes the test fail on the old code (verdict `strengthened`). Edits that make a test pass on both old and new code are rejected. Without `tests.run_files`, only additions are allowed.
- Tasks can declare test changes (`behaviour`, `refactor`, `fixture`).
  `apocha validate --impact` lists existing tests a task may affect.
- Implementers can report tasks as `blocked`; the reviewer confirms or rejects the claim before escalation.
- Implementers list a test or check for each acceptance criterion; the reviewer verifies the evidence.
- `apply_patch` errors show matching line numbers and the closest line, and catch escaped newlines.
  Additions to existing tests are judged line by line.
- `apocha integrate` accepts `--test-edits`.
- The real-sandbox self-test runs inside Apocha, with short socket paths on macOS.
- Every finished run keeps its final code as `candidate.patch` in the run directory, including runs that did not pass. `apocha status <run-id>` shows it, and `git apply --binary` restores it on the base commit.
- An implementer that stops without calling `submit_result` gets one continuation to finish. Each agent's bounded final message is kept in `final-message.txt` in its session directory; the event records only its length as `final_message_chars`. Old events are not rewritten.
- Checks, fixers and test evidence support pnpm workspaces with `dependencies: "pnpm"`. The lockfile and every workspace manifest must match the base commit, installed versions are checked for each workspace package, lockfiles with several YAML documents (pnpm 11 and later) are read in full, and `apocha init` detects pnpm.
- Checks that use pnpm or npm reuse the host's Corepack cache read-only and never download a package manager.
- A check can set `browser: true` so a headless Chromium can run inside the macOS sandbox. It allows only Chromium's own Mach services and implies nothing else.
- Runs stop before the first agent call, with the fix, when Apocha's own dependencies are not installed, and warn when changes to existing tests are limited to additions because `tests.run_files` is not set.
- `apocha status` and `apocha gc` name the branch they checked when no project config is found, and suggest `--target`.

## 0.2.0 (2026-10-06)

- Test edits are additive by default, enforced by the test-edits check.
- tests_on_base records evidence that new tests fail on the base.
- Candidate digests no longer depend on the user's Git configuration.
- Runtime config history is recorded across resumes; repairs can use an unknown bucket.
- --message-file supports commit messages from files, with clearer errors.
- land runs without Git hooks and retires stacked batches.
- Daemon sockets are denied, and secrets are scanned once per run.
- Aborts are never retried.
- The legacy PANAGENT_SANDBOX marker remains supported.
- Reviewer independence is recorded and can be required.
- SSH-signed receipts use allowed signers; land --require-signed enforces signatures.
- The macOS sandbox denies access by default, with per-check loopback access.
  Check definition digests now include the loopback setting.
- verify-range and a verify-only GitHub Action check receipts.
- Dependencies are validated once per run and copied with copy-on-write where available.
  Checks run in parallel with fail_fast support.
- Fixers such as a formatter run on the changed files before checks, configured with `fixers` and `default_fixers`. Their changes become part of the candidate and are recorded.
- A check can skip the OS sandbox with `unsandboxed: true`, set only in the project config. Apocha uses this for a sandbox self-test, and makes the paths that trigger it governance paths.
- On Linux, bubblewrap mounts only existing canonical paths (fixing setups where /var/run is a symlink), denied directories are read-only, and the desktop session bus, X11, the SSH agent, and common database sockets are hidden from checks. Sandbox setup failures count as infrastructure errors. On macOS, checks can no longer open other terminals.
- A run that uses an unsandboxed check needs `--allow-governance-edits` with a reason, and agents cannot run such checks through `run_check`.

## 0.1.0 (2026-10-05)

First release as a standalone package.

- Renamed from Panagent before release. Repositories that still have `panagent.config.json` keep
  working, and receipts written as `panagent.receipt.v3` still verify. Both old config names stay
  governance paths.

- Workflows as data, run by one engine: `code-delivery` and `integrate`, built from the stage
  kinds `agent`, `checks`, `review`, `budget`, `human`, `promote`, and `seed`.
- Adapters for Codex CLI, Claude Code, and Pi, chosen per role in a runtime config, plus a
  scripted fake runtime for tests. Each runtime is limited to the harness tools, with stream
  checks and a live lock-down probe (`apocha doctor --live`).
- Harness tools served over MCP (official SDK, both protocol eras) or a Pi extension, including
  `read_base_file` and `run_check`.
- Checks from a closed catalog in `apocha.config.json`, run in a fresh tree under Seatbelt or
  bubblewrap, with `npm` and `none` dependency policies.
- The reviewer sees the full diff; oversized diffs escalate.
- Every run is recorded with an append-only event log. Usage limits pause runs; `resume`
  continues them. Transient failures are retried once and counted.
- Receipt v3 with task, config, runtime-config, and policy digests and per-check definition
  digests. Verification recomputes the candidate digest from Git. Receipts v1 and v2 still
  verify.
- `metrics` reports outcomes over all runs and delivery statistics from receipts, with
  definitions.
- Ctrl-C and SIGTERM abort runs and record `ERROR`/`aborted`.
- Failed run starts no longer leave `RUNNING` records.
- `findings_per_fix` counts `FIX` review findings only.
- `apply_patch` validates all files before writing.
- Repository `runtimes.json` requires `--trust-repo-runtimes`.
- Checks warn when running without a sandbox; `init` defaults to sandbox mode `required`.
- Sandboxed checks cannot read secret-looking untracked files in the source checkout.
- Temporary directories carry an owner marker and are always removed.
- `land` retires landed batch refs; `--keep-batch` preserves them.
- New `apocha gc` and `apocha status` commands for cleanup and visibility into batches and runs.
- Lifecycle documentation covers status, landing, and cleanup.
