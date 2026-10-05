# Configuration

Three documents configure a run. Each has a JSON Schema in `schemas/`, which is the single
source of truth for its shape. Code adds only the semantic checks a schema cannot express (for
example, that a path is canonical, or that a check ID exists).

| Document | Where | Who changes it |
|---|---|---|
| Project config | `panagent.config.json` at the repository root | People, through a governance edit |
| Runtime config | `.panagent/runtimes.json`, `~/.config/panagent/runtimes.json`, or `--runtimes <file>` | Each user |
| Task manifest | anywhere; passed to `panagent run` | The person or system assigning work |

## Project config (`panagent.config.json`)

Schema: `schemas/project-config.schema.json`. The config is read from the **base commit** of each
run. `panagent.config.json` and `.panagent/` are always governance paths.

```json
{
  "version": 1,
  "checks": {
    "lint":  { "run": ["npm", "run", "lint"], "cwd": "web", "timeout_ms": 120000, "dependencies": "npm" },
    "tests": { "run": ["{source}/.venv/bin/python", "-m", "pytest", "-q"], "env": { "PYTHONPATH": "src" } }
  },
  "check_selection": [
    { "paths": ["web/"], "checks": ["lint"] },
    { "paths": ["src/", "tests/"], "checks": ["tests"] }
  ],
  "default_checks": [],
  "paths": {
    "protected": [".github/"],
    "governance": ["AGENTS.md"],
    "forbidden": ["private/"],
    "design_reference_prefix": "docs/design/"
  },
  "refs": { "batch_prefix": "refs/heads/panagent/batch/", "notes": "refs/notes/panagent" },
  "sandbox": { "mode": "auto", "network": "deny", "deny_read": ["~/.my-tokens"] },
  "limits": { "max_repair_attempts": 2, "default_repair_attempts": 1, "review_diff_bytes": 400000, "run_check_calls": 6, "check_output_bytes": 20000 }
}
```

### `checks`

The closed catalog. Each check:

| Field | Default | Meaning |
|---|---|---|
| `run` | required | argv, no shell. `{source}` expands to the source checkout root, which checks may read (for a venv or toolchain kept there). |
| `cwd` | `.` | Working directory inside the materialized tree |
| `timeout_ms` | 300000 | A timeout is an infrastructure error, not a failure |
| `dependencies` | `none` | `none`: nothing added. `npm`: copy `node_modules` from the source checkout after checking that `package.json` and `package-lock.json` equal the base commit and that installed direct dependencies match the lock. |
| `network` | `false` | Allow outbound network for this check |
| `env` | `{}` | Literal environment additions. No host variables are forwarded except `PATH`, locale, and terminal settings. |
| `description` | | Shown to the implementer next to the check ID |

Every check runs in a fresh directory built from the candidate's Git index: tracked files only, no
`.git`, no untracked or ignored files, and no forbidden paths. `HOME`, `TMPDIR`, and the XDG
directories point at per-check scratch directories.

### `check_selection` and `default_checks`

When a task names no checks, and for every integration, checks are selected from the changed
paths: every rule whose `paths` match a changed file contributes its checks, plus
`default_checks`.

### `paths`

| Field | Meaning |
|---|---|
| `protected` | Never changed by any task |
| `governance` | Protected unless the run uses `--allow-governance-edits --reason "<text>"`. The operator's Git identity and the reason go into the receipt. |
| `forbidden` | Never readable by agents, never materialized for checks, and denied to sandboxed checks in the source checkout. Matching ignores case. |
| `design_reference_prefix` | Where `design_reference` files must live |

### `refs`

`batch_prefix` is where promoted candidates go; `notes` is where receipts go. A repository moving
from another harness can keep its existing refs, so its old receipts stay checkable.

### `sandbox`

| Field | Values | Meaning |
|---|---|---|
| `mode` | `auto` (default), `required`, `none` | `auto` uses Seatbelt or bubblewrap when present. `required` makes a missing backend an infrastructure error. |
| `network` | `deny` (default), `allow` | Project-wide network default for checks |
| `deny_read` | paths, `~/` allowed | Added to the built-in list of credential locations (`~/.ssh`, `~/.aws`, `~/.codex`, `~/.claude`, `~/.npmrc`, `~/.netrc`, `~/Library/Keychains`, and more) |

### `limits`

| Field | Default | Meaning |
|---|---|---|
| `max_repair_attempts` | 2 | Upper bound for any task |
| `default_repair_attempts` | 1 | Used when a task does not say |
| `review_diff_bytes` | 400000 | Larger diffs escalate instead of being reviewed partially |
| `run_check_calls` | 6 | `run_check` calls per implementer attempt |
| `check_output_bytes` | 20000 | Captured output per stream per check (digests always cover everything) |

## Runtime config (`runtimes.json`)

Schema: `schemas/runtime-config.schema.json`. Lookup order: `--runtimes <file>`, then
`<repo>/.panagent/runtimes.json`, then `$XDG_CONFIG_HOME/panagent/runtimes.json`.

```json
{
  "version": 1,
  "roles": {
    "implementer": { "adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium" },
    "reviewer": { "adapter": "claude-code", "model": "claude-sonnet-5-5", "effort": "high" }
  },
  "adapters": {
    "codex": { "command": "codex", "min_version": "0.160.0" },
    "claude-code": { "command": "claude", "min_version": "2.1.289" },
    "pi": { "command": "pi", "min_version": "1.0.2", "provider": "openai-codex" }
  },
  "budgets": { "timeout_ms": 1200000, "max_tool_calls": 150 },
  "retry": { "infra": 1 }
}
```

- `roles.<role>.adapter`: `codex`, `claude-code`, `pi`, or `fake` (tests and demos; set
  `adapters.fake.script` to a module exporting `{ implementer, reviewer }` handlers).
- `model` is required for real adapters. `effort` maps to each runtime's reasoning setting.
  `provider` applies to Pi.
- A reviewer from a different model family than the implementer is recommended: judges score
  output from their own family higher.
- The resolved config is hashed into `runtime_config_digest` in every receipt.

## Task manifest

Schema: `schemas/task.schema.json`.

| Field | Required | Meaning |
|---|---|---|
| `task_id` | yes | `^[a-z0-9][a-z0-9-]{1,63}$` |
| `description` | yes | What to do, and what not to do |
| `acceptance_criteria` | yes | Checked by the reviewer, one by one |
| `allowed_paths` | yes | What the implementer may change. Directory scopes end in `/`. |
| `read_only_paths` | | Readable context the implementer may not change |
| `protected_paths` | | Extra protected paths for this task |
| `initial_context` | | Files placed in the implementer's first prompt (must be readable) |
| `design_reference` | | Up to 5 approved reference files under the design prefix, read from the base commit by both roles |
| `checks` | | Check IDs from the catalog. Omit to select by rule. A run with no checks is refused. |
| `max_repair_attempts` | | 0 to 2, at most the project limit |

A task cannot contain commands, and unknown fields are rejected.
