# Experimental opencode adapter design

The experimental adapter is implemented and registered for opencode **1.19.3 only**.
Other versions are refused until retested. This design and fake-only regression suite do not
establish production support or live lockdown success. Explicit selection is required;
there is no README support/default claim.

Official isolated synthetic probes returned provider HTTP403 stating the free tier is only
usable within OpenCode under strict all-builtins denial. Ordinary CLI and MCP succeeded on
this version. Keeping built-in read at ask allowed MCP success, but that workaround is rejected:
V1 read.ts stats paths before ctx.ask (directory listings and content reads occur after it).
The adapter retains wildcard deny and exact MCP permissions and preserves provider failure.
It never adapts tools, permissions or prompts to bypass provider checks.

## Adapter boundary and invocation

Follow `docs/adapters.md`, `src/adapters/contract.mjs` and the existing Codex/Pi adapters:
`createOpencodeAdapter(settings)` returns `{ name, probe, run }`. `probe()` reports the command,
version, availability and problems; availability alone is not proof of isolation. `run(invocation)`
returns `{ runtime, usage, final_message? }` or throws `HarnessError`. The MCP server writes
`session/tools.jsonl` and `session/result.json`; assistant text is never parsed as a submission.

Launch an argument array equivalent to:

```text
opencode --pure run --format json --agent apocha -m opencode/model [--variant variant]
```

Send `invocation.taskPrompt` on stdin. Put `invocation.systemPrompt` in the generated `apocha`
agent definition, without discovering external instructions. Invocation variant configuration and
contract plumbing are implemented: pass `variant ?? effort` to `--variant`. Unsupported variants
are left to the pinned CLI/provider to reject, and those failures are preserved.

The MVP accepts only unauthenticated `opencode/model` IDs and sets
`enabled_providers: ["opencode"]`. Other provider IDs fail closed with an unsupported
authentication error. Unknown vendor identity, including an explicit `provider: "opencode"`,
is rejected before starting the CLI.

Configure only the local `apocha` MCP server, with a command array containing the Node executable
and the absolute path to `src/adapters/mcp-server-main.mjs`. Its `environment` supplies
`APOCHA_SESSION=invocation.sessionFile`. Require a working server and the exact role tool set.

## Configuration isolation

`OPENCODE_CONFIG` alone merges global configuration. Create an invocation-owned private temporary
directory (mode `0o700`) and place the generated config, empty cwd and separate home/data/cache
subdirectories there. Set all of these explicitly inside that directory:

- `HOME`, `OPENCODE_TEST_HOME`;
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`;
- `TMPDIR` and `OPENCODE_CONFIG` (the generated config file).

Run in the invocation's empty directory, never the source checkout. Set
`OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_PURE=1`, and pass `--pure`. Copy no user auth DB,
account config, plugins, agents, skills or instructions. Disable auto-update, sharing, LSP,
formatters and snapshots in the generated configuration.

Build a minimal environment allowlist; do not reuse `runtimeEnvironment()` unchanged, because it
preserves user homes and provider credentials. Never inherit arbitrary `OPENCODE_*` variables or
unrelated provider credentials. Free public models need no authentication. Explicit paid
credentials and their scoped injection are future work; credentials must never enter receipts.

Machine config locations are checked for existence without reading contents: macOS
`/Library/Application Support/opencode` and managed preferences (system and per-user), Linux
`/etc/opencode`, Windows `ProgramData/opencode`. Presence or inability to establish absence
fails closed, with no policy bypass. Inspect resolved configuration under the exact
invocation environment before any model call, and fail closed if extra MCP servers, tools,
plugins, instructions, permissions or other configuration contaminate the generated boundary.
An unreadable or unverifiable resolved configuration cannot count as clean. Keep the adapter
experimental until resolved-config inspection and live checks pass, and revalidate after upgrades.
Temporary homes alone are not evidence that every configuration source was excluded.
Implemented preflight captures the bounded pretty JSON document in a cancellable helper using
runJsonlProcess's process group and the invocation's remaining total budget. It compares the
resolved policy to the generated config, then checks that the on-disk private config was not
modified. Version queries also use an isolated environment. This trusts the selected executable;
a malicious executable can lie, and configuration isolation is not an OS sandbox.

## Tool prevention and detection

Derive the runtime allowlist from `toolDefinitions(invocation.role)`, mapping each exact name to
`apocha_<tool-name>`. Both the global permission map and the `apocha` agent permission map must
deny `"*"` first, then allow only those exact MCP names. Do not allow `apocha_*` by prefix or
permit implementer-only tools in a reviewer invocation.

Deny all built-ins: `bash`, `edit`, `write`, `apply_patch`, `read`, `glob`, `grep`, `webfetch`,
`websearch`, `task`, todo tools, `skill`, `lsp`, `question`, `plan`, and code-mode `execute`.
The wildcard denial also covers future tool names. Built-in `apply_patch` remains denied while
`apocha_apply_patch` is allowed only when the role definition includes it. Code-mode execution
must not provide an indirect path to forbidden tools.

Configuration is prevention. The JSON run stream emits completed/error `tool_use` events,
not a pre-execution interception point. Inspect every such event against the exact role set;
a foreign tool event is `policy_violation` even if its execution was denied. Stop the process
on detection, but do not claim stream inspection prevented an action that may already have run.
Reject malformed harness tool protocol as `tool_protocol`. Do not log tool arguments or results
into controller events.

## Identity, usage and lifecycle

Record `runtime.adapter` as `opencode`, the CLI version as `adapter_version`, and the full model
identifier, including an `opencode/...` prefix when selected. Provider identity means the actual
vendor, such as DeepSeek or Zhipu, rather than the opencode gateway. For opencode-hosted models,
require explicit vendor metadata to establish reviewer independence. Resolve that metadata before
agents run, consistently with `roleProvider`; unknown identity cannot establish independence.
Different adapters or gateway prefixes do not prove different providers.

Aggregate each `step_finish` once, using numeric `part.tokens` fields:

| Stream field | Usage field |
|---|---|
| `input` | `input_tokens` |
| `output` | `output_tokens` |
| `reasoning` | `reasoning_tokens` |
| `cache.read` | `cached_input_tokens` |
| `cache.write` | `cache_write_tokens` |
| `part.cost` | `cost_usd` |

Sum across steps; leave unavailable usage unknown rather than inventing measurements. Keep the
last assistant `text` as a bounded `final_message` of at most 2000 characters. Existing lifecycle
code stores it privately in `final-message.txt` with mode `0o600` and records only its length.
Events contain numeric usage and identity, never prompts, file contents or model output.

Read provider errors from `error.data.message` and call `classifyProviderMessage`, preserving
`retryAfter` for `usage_limited`; other provider failures are `provider`. Process launch/exit
failures without a provider error are `infra`. Forbidden tools are `policy_violation`, invalid
tool protocol is `tool_protocol`, and completion without a valid harness submission is `agent`.
Submission validation stays with the controller. Preserve the existing rule that a valid submitted
result can count despite a later runtime failure; policy violations are never retried.

Use `runJsonlProcess` with `timeoutMs`, abort `signal`, stdin and an event inspector. Its process-group
kill handles timeout, abort and inspector failures, including MCP descendants. Timeout/abort are
`infra`. Remove the invocation-owned temporary directory in `finally` on success and every failure,
after the process terminates. Bound and sanitize diagnostics; never persist credentials or raw
prompt/output-bearing stream events in receipts.

## Doctor, security validation and privacy

The adapter probe labels it experimental without treating that warning as install failure.
Doctor must warn prominently before any free third-party model
use: task prompts and tool-returned source content go to that provider. Never send private content.
Keep the existing `sourceSecretFiles` check; add rejection of secret-looking repositories before
model calls rather than treating the current informational `sourceSecretsProbe` as a sufficient
gate. Before launching the CLI for a model invocation, the adapter reads the local session policy,
rejects any sourceSecretFiles result and scans tracked filenames for .env/.env.*, pem/key,
id_rsa/id_ed25519 (safe example/sample/template tracked names excepted). It never reads secret
contents or includes rejected path names in diagnostics. A secret-file scan is a filename
heuristic, not proof that all other source content is public. Use only synthetic
scratch data for live validation, with no copied user configuration or repository content.

Future work (not implemented here): extend the synthetic `liveProbe` flow and propagate variant
there. Ask for a shell/write outside the harness and a read of `/etc/hosts`, then require harness
`apply_patch` and `submit_result`. Pass only with no forbidden
capability events, no file created outside harness tools, and a verified harness patch/submission.
The current probe runs an implementer session even when selecting reviewer model settings, so it
does not establish reviewer-role isolation. Require a separate real synthetic smoke for each actual
role and its exact tool set; reviewer smoke must use reviewer-allowed tools and submission without
granting patch access. A denied foreign event still fails the probe.

Unit tests use fake events and subprocesses only. Cover arguments/stdin, isolated environment and
resolved-config rejection, both permission maps, exact role names, built-in versus MCP patch,
denied foreign events, usage aggregation, bounded text, error classes, missing submission and
process-group cleanup on abort/timeout. These tests do not establish live lockdown. Require real
synthetic smoke for each role before any support claim, and rerun after runtime upgrades.
Cross-provider reviewer-injection evaluation is separate and private; this document contains no
evaluation data. Live results and unresolved machine-config behavior must be assessed before
advancing beyond experimental status.

## References

- [opencode 1.19.3 source](https://github.com/anomalyco/opencode/tree/v1.19.3/packages/opencode/src): CLI run events, config loading, agents, tool registration and permissions.
- [Permissions](https://docs.opencode.ai/docs/permissions/).
- [MCP servers](https://docs.opencode.ai/docs/mcp-servers/).

The versioned source and CLI probes are the evidence baseline; current online documentation may
describe a later release.
