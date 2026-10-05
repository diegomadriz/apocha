# Changelog

## 0.1.0 (unreleased)

First release as a standalone package.

- Workflows as data, run by one engine: `code-delivery` and `integrate`, built from the stage
  kinds `agent`, `checks`, `review`, `budget`, `human`, `promote`, and `seed`.
- Adapters for Codex CLI, Claude Code, and Pi, chosen per role in a runtime config, plus a
  scripted fake runtime for tests. Each runtime is limited to the harness tools, with stream
  checks and a live lock-down probe (`panagent doctor --live`).
- Harness tools served over MCP (official SDK, both protocol eras) or a Pi extension, including
  `read_base_file` and `run_check`.
- Checks from a closed catalog in `panagent.config.json`, run in a fresh tree under Seatbelt or
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
- New `panagent gc` and `panagent status` commands for cleanup and visibility into batches and runs.
- Lifecycle documentation covers status, landing, and cleanup.
