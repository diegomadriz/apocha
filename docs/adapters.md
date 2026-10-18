# Adapters

An adapter starts one agent runtime for one role and waits for it to finish. It gives the runtime
the harness tools, removes everything else the runtime could do, and watches the runtime's event
stream for anything that slipped through.

## Contract

`src/adapters/contract.mjs`:

```text
adapter.probe()          -> { adapter, command, version, ok, problems[] }
adapter.run(invocation)  -> { runtime: { adapter, adapter_version, provider, model }, usage }
                            throws HarnessError(class: infra | provider | usage_limited | agent
                                                       | tool_protocol | policy_violation)
```

`invocation` carries the role, model, effort, system prompt (from `src/prompts/`), task prompt
(the JSON bundle), the session directory and session file, an empty working directory, a timeout,
and an abort signal.

An adapter does **not** return the agent's result. The harness tool server writes every tool call
to `session/tools.jsonl` and the submitted result to `session/result.json`, and the controller
reads them from there. Every runtime calls the same `submit_result` tool, so there is one result
format and no runtime-specific output parsing. Adapters parse their runtime's stream only for exit
status, usage, model identity, final assistant text, error classification, and policy checks.

Implementers use `submit_result` to explain the result and show how each criterion was met.
It requires `summary` and accepts `unresolved_uncertainties`.
`status` is `done` by default, or `blocked`.

For `done`, provide `criteria_evidence`: one `{ criterion, evidence }` entry per
acceptance criterion, numbered from 1. Each evidence array needs 1–10 items:

- `{ kind: "test", path, name }`: an existing project test path and a name found literally in it.
- `{ kind: "check", check_id }`: a check named by the task.
- `{ kind: "inspection", note }`: 1–500 characters explaining why the criterion cannot reasonably be tested.

Invalid evidence returns all problems without saving the result. Correct it and resubmit.
Blocked results may omit evidence. They require `blocked_reason`: 1–2000 characters
naming the conflicting test, check, or path and explaining the conflict.
Omit `blocked_reason` for `done`. Invalid pairings are rejected before saving.

Every blocked report goes to the read-only reviewer without checks.
The reviewer sees `untrusted.blocked_reason` and `untrusted.blocked_summary`, the current diff, task rules,
and latest verification evidence:

- `ESCALATE` confirms the conflict.
- `FIX` rejects it and gives repair findings.
- `PASS` also rejects it and becomes `FIX`.

Rejections spend the repair budget. Fix failed work, rejected edits, and unfinished
work instead of reporting them as blocked.

## How tools reach each runtime

| Runtime | Binding | Notes |
|---|---|---|
| Codex CLI | MCP over stdio (`src/adapters/mcp-server-main.mjs`) | configured with `-c mcp_servers.apocha.*` |
| Claude Code | MCP over stdio | `--mcp-config` with `--strict-mcp-config` |
| Pi | Pi extension (`src/adapters/pi/extension.mjs`) | registers the same tools in-process |
| Experimental opencode 1.19.3 | isolated local MCP, exact role names | explicit selection only; [design and limits](opencode-adapter-design.md) |
| fake | direct calls | for tests and demos |

The MCP server uses the official TypeScript SDK (`@modelcontextprotocol/server`). Its
`serveStdio` serves both the 2025 handshake and the 2026-07-28 stateless protocol on one
connection, which matters while clients migrate between them. The SDK is the package's only
runtime dependency, and only the tool server process loads it.

## Lock-down per runtime

### Codex CLI (`codex exec`)

- Runs on your ChatGPT sign-in or an API key, through the official CLI.
- `--ignore-user-config --ephemeral`, `-s read-only`, `approval_policy="never"`,
  `web_search="disabled"`, `project_doc_max_bytes=0`.
- Disabled features (`DISABLED_FEATURES` in `src/adapters/codex/index.mjs`): the shell and exec
  tools, app connectors, plugins, browser and computer use, image generation, goals, memories,
  sub-agents, skills, hooks, and the rest of the tool-bearing features. Without this list a
  ChatGPT-signed-in Codex exposes hundreds of connector tools (repository hosting, deployment,
  file storage) even with the shell off.
- `code_mode_host` must stay enabled: Codex routes tool calls through it. Code mode has no
  filesystem access.
- Stream check: any `command_execution`, `file_change`, `web_search`, collaboration item, or MCP
  call to a server other than `apocha` (apart from Codex's own resource listing) ends the run
  with `policy_violation`.

### Claude Code (`claude -p`)

- Runs on your Claude sign-in or an API key, through the official CLI.
- `--tools ""` removes every built-in tool. `--strict-mcp-config` with only the harness server.
  `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`, an empty
  working directory, and permission mode `dontAsk` with only `mcp__apocha__*` allowed.
- Stream check: the `init` event's tool list must contain only `mcp__apocha__*` tools, and the
  harness server must be connected, before any work starts. Every assistant `tool_use` must be a
  harness tool.

### Pi (`pi --mode json --print`)

- `--no-builtin-tools --no-extensions --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-session --no-approve`, an explicit `--tools` allowlist, and the harness
  extension.
- Stream check: any `tool_execution_start` for a tool outside the harness ends the run.
- Pi's `openai-codex` provider reaches a ChatGPT subscription through an unofficial path. Prefer
  the `codex` adapter for subscription use.

### Experimental opencode (`--pure run --format json`)

Implemented for **1.19.3 only**, with no support/default claim. Select explicitly.
A successful version probe establishes installation only and reports experimental status.
Doctor warns for every configured opencode role that it is experimental and public/synthetic-only.
Its additional source privacy check rejects secret-looking tracked filenames and files found
by the existing untracked/ignored source-secret scan before any live model call.
This screening never reads or prints source contents and does not certify privacy.

Only unauthenticated `opencode/model` gateway models are accepted. An explicit actual
vendor is required in role or adapter settings; the gateway is not a vendor.
`variant ?? effort` is passed to the CLI. A private 0700 temporary directory isolates
home, XDG locations, cwd, config and temp files. Only PATH, LANG and LC_ALL are inherited.
Machine configuration is refused, resolved config is checked before the model call,
and both permission maps deny `*` while allowing exact role MCP names only.
Resolved config comparison tolerates only CLI metadata (`$schema`, `username`) and exactly
empty plain objects at `mode`, `command`, and `agent.apocha.options` when absent from
the expected config. Nonempty values, arrays, null, and every other unexpected field
remain rejected. The owned config is checked again after preflight to detect on-disk
mutation even when debug output claims the expected policy. Temporary state is removed in finally.

Use **public/synthetic inputs only**: prompts and tool-returned content reach a third-party
provider. The pre-call filename scan rejects untracked source secrets and tracked
secret-looking paths. Key (`.key`), PEM (`.pem`), and SSH (`id_rsa*`, `id_ed25519*`)
basenames remain secret-looking even with example/sample/template labels. Only exact
`.env.example`, `.env.sample`, and `.env.template` basenames are exempt from the tracked
filename heuristic; the existing untracked source-secret check still applies. This is a
filename heuristic, not content inspection: safe template names can contain secrets, and
other filenames can conceal them, so it cannot prove data is public. This is CLI configuration
isolation, not an OS sandbox or a defense against a malicious executable. Stream
inspection detects violations after possible execution, and does not persist whole events.

Official synthetic CLI probes returned provider HTTP403 stating the free tier is only usable
within OpenCode under strict all-builtins denial. Ordinary CLI and MCP worked on 1.19.3;
allowing built-in read at ask also worked, but is unsafe: V1 read stats paths before its
permission gate. This adapter keeps read and every other built-in denied, preserves provider
failure, and never adapts the policy or prompts to bypass this gate. No live lockdown success
is claimed. See the [design](opencode-adapter-design.md) for evidence limits.

## Reviewer independence

Provider identity is resolved before agents run: Codex is `openai`, Claude Code is
`anthropic`, and fake is `fake`. Pi uses the role's provider, falling back to
`adapters.pi.provider`; `openai-codex` normalizes to `openai`, and other provider
strings are preserved. An unspecified Pi provider is `unknown`. Opencode gateway identity is separate from the actual
model vendor; missing actual vendor metadata is `unknown`. Doctor reports unknown vendor
independence as not established and fails when independence is required.
Different adapters can therefore share a provider. Same-provider judges tend to
prefer their own model family's output, so cross-provider review is stronger evidence.
Set project `review.require_independent` to require different providers.

## Checking the lock-down

```bash
apocha doctor --live
```

For each configured role, `--live` starts the runtime in a scratch repository and asks the model
to create a file and read `/etc/hosts` by any means other than the harness tools, then to use
`apply_patch` and submit. The probe passes only if the runtime reports no forbidden capability, no
file appears outside the harness tools, and the harness tools still work. Run it after every
runtime upgrade: a new default-on feature in a runtime is the most likely way for the lock-down to
weaken.

For opencode, the probe uses the actual configured role and the existing role prompt.
It preserves configured effort and variant exactly (including absence); other adapters
retain their low-effort implementer probe. The implementer must create synthetic `probe.txt`
containing `ok` through `apply_patch` and submit with `criteria_evidence: []`.
The reviewer instead reads a pre-created synthetic `probe.txt` through `read_files`
and submits a PASS bound to a supplied synthetic candidate digest, with empty findings.
Its session has no writable paths, and its tool schema is reviewer-specific: neither
`apply_patch` nor `run_check` is granted. The reviewer result schema requires the candidate digest. Both roles are asked to try a shell/outside write and reading `/etc/hosts`.
Successful expected tool traces and results are required; reviewer candidate changes and
`escaped.txt` in either scratch repository or cwd fail the probe. Foreign tool events
fail even if reported denied. Provider failures, including HTTP403, remain failures.
Diagnostics bound the implementer summary to 160 characters.

These synthetic observations exercise role wiring and reported tool boundaries, not all
possible filesystem escapes or the trustworthiness of an executable. An absent escape file
does not prove no outside read occurred. No real repository content is sent by the live
probe, and passing cannot certify privacy, vendor identity, or general support.

When available, the invocation’s last assistant text is truncated to 2000 characters and kept in `final-message.txt` in its session directory with mode `0o600`. The `agent.finished` event records only the bounded text’s length as `final_message_chars`, never the text itself. Codex uses the last completed `agent_message`, Claude Code uses its parsed result text, and fake handlers may return `{ final_message }`. Adapters without that text omit the file and length field. Old events written by earlier versions are not rewritten.

## Errors and retries

Adapters classify failures:

- Provider messages about usage or rate limits (`usage limit`, `rate limit`, `429`, `try again
  at ...`) become `usage_limited`, with the reset time when the runtime gives one. The run pauses.
- Other provider errors become `provider` and are retried once.
- Process failures and timeouts become `infra` and are retried once.
- Policy violations are never retried.
- If the runtime fails after the agent already submitted a valid result, the result counts.

## Adding an adapter

1. Create `src/adapters/<name>/index.mjs` exporting `create<Name>Adapter(settings)` that returns
   `{ name, probe, run }`.
2. Give the runtime the harness tools: point it at `mcp-server-main.mjs` with
   `APOCHA_SESSION=<invocation.sessionFile>` if it speaks MCP, or register
   `toolDefinitions(role)` with `createProjectTools(session)` in-process.
3. Turn off every built-in capability the runtime has, run it in `invocation.cwd`, and pass
   `invocation.systemPrompt` and `invocation.taskPrompt`.
4. Inspect its event stream: throw `HarnessError("policy_violation", ...)` on any action outside
   the harness tools, and classify errors with `classifyProviderMessage`.
5. Register it in `src/adapters/index.mjs` and `schemas/runtime-config.schema.json`.
6. Add argument and stream-inspection tests to `test/adapters.test.mjs`, and run
   `apocha doctor --live` against it.
