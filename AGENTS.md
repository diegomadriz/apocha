# Working on this repository

This file is for agents and people changing Apocha itself.

## Map

| Path | What lives there |
|---|---|
| `bin/apocha.mjs` | CLI entry; everything else is in `src/` |
| `src/cli/` | Commands (`main.mjs`), `init`, and the live lock-down probe |
| `src/core/` | Engine, run lifecycle, run store and events, lock, metrics, workflow validation |
| `src/core/gc.mjs` | Cleanup plans and removal of leftover resources |
| `src/core/status.mjs` | Batches, receipts, runs, and next steps |
| `src/workflows/` | Workflow definitions (data) |
| `src/stages/` | One module per stage kind; `invoke.mjs` runs an agent with the retry policy |
| `src/tools/` | Harness tools and their definitions (shared by every runtime) |
| `src/adapters/` | Runtime adapters, the MCP tool server, process handling |
| `src/checks/`, `src/sandbox/` | Running catalog checks in a fresh tree under an OS sandbox |
| `src/git/` | Candidate, promotion, receipts, land |
| `src/config/` | Project config, runtime config, task manifests |
| `src/util/` | Errors, git, digests, bounded text, safe file access, schema validator |
| `src/util/temp.mjs` | Owned temporary directories and cleanup |
| `src/prompts/` | Role prompts (hashed into receipts) |
| `schemas/` | JSON Schemas: the single source of truth for every document shape |
| `docs/` | Architecture, configuration, adapters, workflows, receipts, security, operations |
| `test/` | `node --test` suites; `helpers.mjs` builds throwaway repositories |
| `examples/toy-node/` | A small project and task for trying Apocha |

Start with `docs/architecture.md`.

## Checks

```bash
npm run lint        # biome check .
npm run typecheck   # tsc over JSDoc types (// @ts-check in every module)
npm test            # node --test, no network, fake runtimes
```

All three must pass. The sandbox tests run only where Seatbelt or bubblewrap is available, and
they skip inside an already-sandboxed check.

## How changes are made

Changes go through Apocha itself. `apocha.config.json` defines the catalog (`lint`,
`typecheck`, `test`) and the protected and governance paths. Run tasks with
`apocha run`, integrate with `apocha integrate`, and land with `apocha land`. Never push.

Governance paths (`AGENTS.md`, `src/prompts/`, `schemas/`, `apocha.config.json`) change only
with `--allow-governance-edits --reason "<why>"`, and a person reviews the result.

Start with `apocha status` to see open batches and runs. After landing, `land` retires the batch branch. Finish with `apocha gc`, and run `apocha gc --apply` only when the plan lists nothing you still need. Do not leave worktrees, branches, or temp files of your own. Remove what you created before you finish.

## Rules for code

- Plain Node ESM, `// @ts-check` with JSDoc types, no build step.
- One runtime dependency (`@modelcontextprotocol/server`), imported only by
  `src/adapters/mcp-server.mjs`. Adding a dependency needs a person's approval.
- Throw `HarnessError(errorClass, code, message)` for any failure that crosses a module boundary;
  the error class decides the run outcome (see `src/util/errors.mjs`).
- Every document shape lives in `schemas/`. Validate with `assertValid` / `validateAgainst`; add
  semantic checks in code only for what a schema cannot say.
- Keep the invariants in `docs/architecture.md#invariants`. A change that weakens one needs a
  person's approval and a test that shows the new boundary.
- Tool traces and events never contain file contents, prompts, or model output.
- Update the matching document in `docs/` with any behavior change.
