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
| `unsandboxed` | `false` | Skip the OS sandbox for this check, even under `sandbox.mode: "required"`. No sandbox markers are set; the result and receipt record `none`. A governance-controlled catalog choice, warned on every run and listed by doctor. |
| `network` | `false` | Allow network for this check |
| `loopback` | `false` | Seatbelt: allow loopback bind, listen and connect, including host loopback services. Bubblewrap: accepted as a no-op inside its private network namespace. |
| `env` | `{}` | Literal environment additions. No host variables are forwarded except `PATH`, locale, and terminal settings. |
| `description` | | Shown to the implementer next to the check ID |

Every check runs in a fresh directory built from the candidate's Git index: tracked files only, no
`.git`, no untracked or ignored files, and no forbidden paths. `HOME`, `TMPDIR`, and the XDG
directories point at per-check scratch directories.
For npm checks, successful lock validation is cached per run and dependency directory,
including repair attempts. Source manifest, lockfile, and installed lockfile digests
are checked before reuse; changed inputs trigger validation again. Copies use
clonefile on macOS or reflinks on Linux when available, with a recursive-copy
fallback. Every check has its own writable dependency tree, and copied symlinks
must remain inside that tree.
Seatbelt denies DNS, loopback and outside Unix sockets by default. Workspace Unix sockets
remain available for tool IPC. Set `loopback: true` for checks that run local servers or bundler
workers; this does not enable DNS or external network. `network: true` or `sandbox.network: "allow"`
enables network regardless of `loopback`, while listed daemon sockets remain denied.

### `fixers` and `default_fixers`

Optional closed fixer catalog, read from the base commit and included in the config digest.
Each definition accepts `description`, `run` (argv, no shell), `cwd`, `timeout_ms`,
`dependencies: "npm"` or omitted, and literal `env`, with the same defaults and
validation as checks. An optional whole `{files}` argv element expands to eligible
changed paths relative to `cwd`; embedded or repeated placeholders are rejected.

For example:
`{"fixers":{"format":{"run":["npx","--no-install","biome","format","--write","{files}"],"dependencies":"npm"}},"default_fixers":["format"]}`.

`default_fixers` is an ordered list of catalog IDs (default empty). A task may
set `fixers` to a subset, including `[]` to disable all fixers. Unknown IDs and
task-supplied commands are rejected. The implementer bundle names the automatic fixers.

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
Without `tests.run_files`, the default `justified` test-edit policy enforces
`additive`: existing test lines may only be extended, and existing test files
cannot be deleted. Both `apply_patch` and the structural check enforce this.
Verification records `effective_policy` and the reason
"justified needs tests.run_files to gather evidence; enforcing additive".
With `run_files` configured, `justified` uses the existing test-change evidence
path. `apocha doctor` warns when it is missing; `apocha init` includes it for
projects whose test script uses `node --test`.

After catalog checks pass, up to 10 added or modified test files run individually
against the base tree with the candidate test and added test-support files overlaid.
Deleted tests are skipped. Review bundles expose `tests_on_base` and receipts
record `tests.on_base`: `passes_on_base`, `fails_on_base`, `error` (timeout or
infrastructure failure), or `not_run` (over the limit).
A passing-on-base result is evidence for the reviewer, not proof of a bad test:
refactors and new coverage of existing behavior may legitimately pass.

### `review.require_independent`

Boolean, default `false`. When `true`, start and resume refuse equal implementer
and reviewer providers with config error `reviewer_not_independent`, before any
agent starts or the run becomes RUNNING. This policy comes from the base commit.
`doctor` reports whether independence is required and warns for same-provider roles.

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
| `check_concurrency` | 2 | Maximum parallel catalog checks, integer from 1 to 8; each has its own workspace and sandbox |
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
| `fixers` | | Fixer IDs from the base catalog. Omit for `default_fixers`; `[]` disables automatic fixers. |
| `fail_fast` | | Boolean, default false. After a failing check, skip checks not yet started; running checks finish. |
| `max_repair_attempts` | | 0 to 2, at most the project limit |
| `new_tests_must_fail_on_base` | | Boolean, default false. With `tests.run_files` enabled, any `passes_on_base` result fails `tests-fail-before` and goes to repair. Errors do not count as evidence. |
| `test_edits` | | `justified` (default): existing test changes are permitted, with necessity and weakening evidence checked after task checks pass when `tests.run_files` is configured. `additive`: existing test files may gain lines anywhere and named specifiers on single-line ES imports; all base lines must remain in order except for these import extensions. `new-files`: existing tests may not be modified or deleted. `allowed`: any test change, including deletion. |

The test policy applies to files matching `tests.paths` that exist at the base commit.
New test files are always permitted within `allowed_paths`. Tools reject disallowed
edits with `test_edit_policy`. Under `additive`, the tool judges the resulting file
after all edits against the base commit, cumulatively across calls. The structural
check uses the same line-level classifier. A single-line `import { a, b as c } from "module";`
may gain named specifiers while preserving every old specifier, the module, and any
default binding. Other changed or removed base lines, including file deletion, are
refused. If this prevents completing the task, submit status `"blocked"` with the
tests and reason in `blocked_reason`.
Under `justified`, tools permit existing test edits and structural checks report them
without rejecting them. Pure additions need no necessity evidence. With
`tests.run_files`, the controller runs each non-additively modified or deleted
test's base version on the candidate (up to 10 files; exceeding the limit fails).
An old test that still passes makes the edit unnecessary unless declared as a refactor. If the old test fails
on the candidate but the new test passes on base, the edit is weakened. Both fail
the repairable `test-changes` check; evidence errors are infrastructure errors.
Necessary edits pass, subject to reviewer judgment of the intended behaviour change.
Without `tests.run_files`, necessity evidence is unavailable.
Review bundles include `test_changes` evidence with each file's base-to-candidate
diff, bounded by the main review limit, and list `added_tests` and `modified_tests`.

A task cannot contain commands, and unknown fields are rejected.

## Receipt signing

Operator runtime config may set `"signing": { "key": "~/.ssh/receipt_key", "principal": "operator@example.com" }`.
The key path supports `~/`; keep the SSH private key outside the repository. SSH signing
uses `ssh-keygen` offline and adds no dependencies. Omit this setting for unsigned receipts.

Project config may set `"receipts": { "allowed_signers": ".apocha/allowed_signers", "require_signed": true }`.
Defaults are `.apocha/allowed_signers` and `false`. The repository-relative signers path
is always a governance path, including custom paths. Use standard SSH allowed_signers
lines, for example `operator@example.com ssh-ed25519 AAAA...`.

`land --require-signed` also enables enforcement. Land uses both policy and allowed signers
from the target branch tip; adding a key only on the source does not authorize landing.
`doctor` reports whether a signing key is configured, whether its public key is authorized
for its principal in HEAD's allowed signers, and whether signatures are required.

## Declared test changes

A task may include `test_changes`, an array of at most 50 entries:
`{ "path": "test/value.test.mjs", "kind": "behaviour", "reason": "Expected output changes" }`.
Each path must be an existing test file at the base commit, match the project's
test paths, and fall inside `allowed_paths`. Duplicate paths are rejected.
Declarations and reasons are covered by the task digest.

Under `test_edits: "justified"`, `behaviour` keeps the existing necessity and
weakening rules. A `refactor` waives the necessity check: when the old test
passes on the candidate, the verdict is `refactor`. When the old test fails on
the candidate, normal behaviour change rules apply (`necessary` if the new test
fails on base, `weakened` if it passes on base), with a note that the declaration
did not match the execution evidence.
The assertion token heuristic is advisory only. Every modified file's
`test_changes` entry records `assertions_preserved` in verification, review and
receipts. A false result never fails `test-changes` by itself; declared refactors
with a false result are listed in the review bundle's `refactors_to_check` with
an explanation, so the reviewer can check coverage and possible bypasses.
Renamed assertion locals and extracted helpers may legitimately fail the heuristic.
Support files with no runnable tests must be declared as `fixture` to skip
evidence runs (verdict `declared_fixture`). Undeclared support files are run
like other changed tests. Evidence records declaration status, kind and reason;
the review bundle separately lists undeclared changed test files.

`read_only_paths` and `allowed_paths` must not overlap: neither may equal,
contain, or sit inside an entry of the other. For example, read-only
`schemas/` conflicts with editable `schemas/task.schema.json`.
