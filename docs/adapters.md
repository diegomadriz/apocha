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

## Reviewer independence

Provider identity is resolved before agents run: Codex is `openai`, Claude Code is
`anthropic`, and fake is `fake`. Pi uses the role's provider, falling back to
`adapters.pi.provider`; `openai-codex` normalizes to `openai`, and other provider
strings are preserved. An unspecified Pi provider is `unknown`.
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
