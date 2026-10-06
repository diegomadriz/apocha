# Configuration

Three documents configure a run. Each has a JSON Schema in `schemas/`, which is the single
source of truth for its shape. Code adds only the semantic checks a schema cannot express (for
example, that a path is canonical, or that a check ID exists).

| Document | Where | Who changes it |
|---|---|---|
| Project config | `apocha.config.json` at the repository root | People, through a governance edit |
| Runtime config | `.apocha/runtimes.json`, `~/.config/apocha/runtimes.json`, or `--runtimes <file>` | Each user |
| Task manifest | anywhere; passed to `apocha run` | The person or system assigning work |

## Project config (`apocha.config.json`)

Schema: `schemas/project-config.schema.json`. The config is read from the **base commit** of each
run. `apocha.config.json` and `.apocha/` are always governance paths.

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
  "refs": { "batch_prefix": "refs/heads/apocha/batch/", "notes": "refs/notes/apocha" },
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

### `tests.paths`

Test detection defaults to `["test/", "tests/", "__tests__/", "*.test.*", "*.spec.*"]`
when `tests` or `tests.paths` is omitted. An empty list disables detection.
An entry ending in `/` matches that directory prefix. An entry containing `*`
matches the file basename: `*` matches any characters within that basename,
never across `/`. Other entries match exact repository paths. For example,
`{"tests": {"paths": ["test/", "*.spec.*", "qa/check.mjs"]}}`.
These settings are included in the project config digest and read from the base commit.

### `tests.run_files`

Optional check-like command for fail-before evidence, for example
`{"run": ["node", "--test", "{files}"], "cwd": ".", "timeout_ms": 300000, "dependencies": "npm"}`.
The argv must contain exactly one whole element `{files}`; it expands to test paths,
one per argument, relative to `cwd`. Working directory, timeout, and literal `env`
follow catalog check rules; `dependencies` may be `npm` or omitted.
The normalized definition is included in the config digest. Omit it to disable base runs.

After catalog checks pass, up to 10 added or modified test files run individually
against the base tree with the candidate test and added test-support files overlaid.
Deleted tests are skipped. Review bundles expose `tests_on_base` and receipts
record `tests.on_base`: `passes_on_base`, `fails_on_base`, `error` (timeout or
infrastructure failure), or `not_run` (over the limit).
A passing-on-base result is evidence for the reviewer, not proof of a bad test:
refactors and new coverage of existing behavior may legitimately pass.

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

| `deny_sockets` | paths, `~/` allowed | Added to the built-in local daemon socket deny list, regardless of the network setting |

Socket defaults are `/var/run/docker.sock`, `/run/docker.sock`,
`~/.docker/run/docker.sock`, `~/.colima/default/docker.sock`,
`~/.orbstack/run/docker.sock`, `/run/containerd/containerd.sock`,
`/run/podman/podman.sock`, and
`~/.local/share/containers/podman/machine/podman.sock`.
User entries extend these defaults. Home paths are expanded and existing symlink
targets are included. Seatbelt denies outbound connections; bubblewrap binds
`/dev/null` over each existing socket path.

`apocha init` writes mode `required`. In `auto` mode, a run with no available
backend emits a warning event and a stderr warning suggesting `sandbox.mode: required`.

### `limits`

| Field | Default | Meaning |
|---|---|---|
| `max_repair_attempts` | 2 | Upper bound for any task |
| `default_repair_attempts` | 1 | Used when a task does not say |
| `review_diff_bytes` | 400000 | A larger diff escalates to a person; it is never reviewed in part |
| `run_check_calls` | 6 | `run_check` calls per implementer attempt |
| `check_output_bytes` | 20000 | Captured output per stream per check (digests always cover everything) |

## Repositories set up under the old name

The project was renamed from Panagent to Apocha before its first release. When
`apocha.config.json` is missing, Apocha reads `panagent.config.json` from the base commit.
If both exist, `apocha.config.json` wins. `panagent.config.json` and `.panagent/` are always
governance paths, so changing them requires governance edit permission.

The default refs are now `refs/heads/apocha/batch/` and `refs/notes/apocha`. To keep the old
refs, set `refs.batch_prefix` to `refs/heads/panagent/batch/` and `refs.notes` to
`refs/notes/panagent` explicitly in the project config. To use the new notes ref with existing
receipts, copy the old notes ref with `git update-ref refs/notes/apocha refs/notes/panagent`.

The run store is now `<git-common-dir>/apocha/`. Move `<git-common-dir>/panagent/` to
`<git-common-dir>/apocha/` to keep run history and analytics.

## Runtime config (`runtimes.json`)

Schema: `schemas/runtime-config.schema.json`. Lookup order: `--runtimes <file>`, then
`<repo>/.apocha/runtimes.json` only when opted in, then
`$XDG_CONFIG_HOME/apocha/runtimes.json` (default `~/.config/apocha/runtimes.json`).
An explicit `--runtimes <file>` always wins. Repository configs can choose executable
commands, so they are ignored by default with a notice on stderr. To trust one, pass
`--trust-repo-runtimes` to `run`, `integrate`, `resume`, or `doctor`, or set
`APOCHA_TRUST_REPO_RUNTIMES=1`.

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
| `new_tests_must_fail_on_base` | | Boolean, default false. With `tests.run_files` enabled, any `passes_on_base` result fails `tests-fail-before` and goes to repair. Errors do not count as evidence. |
| `test_edits` | | `additive` (default): existing test files may gain lines but no existing line may change or be removed. `new-files`: existing tests may not be modified or deleted. `allowed`: any test change, including deletion. |

The test policy applies to files matching `tests.paths` that exist at the base commit.
New test files are always permitted within `allowed_paths`. Tools reject disallowed
edits with `test_edit_policy`; under `additive`, each replacement must contain
`old_text` unchanged as a contiguous substring. The final diff is checked independently.
Review bundles list `added_tests` under every policy and `modified_tests` when
`allowed` permits existing test changes; reviewers must judge whether those changes are justified.

A task cannot contain commands, and unknown fields are rejected.
