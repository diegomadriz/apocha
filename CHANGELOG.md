# Changelog

## 0.2.0 (unreleased)

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

## 0.1.0 (unreleased)

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
