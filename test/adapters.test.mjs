// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeArgs, claudeUsage, inspectClaudeEvent } from "../src/adapters/claude-code/index.mjs";
import { codexArgs, DISABLED_FEATURES, inspectCodexEvent } from "../src/adapters/codex/index.mjs";
import { inspectPiEvent, piArgs } from "../src/adapters/pi/index.mjs";
import { classifyProviderMessage, compareVersions, runJsonlProcess } from "../src/adapters/process.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";

import { HarnessError } from "../src/util/errors.mjs";
import { writeJsonAtomic } from "../src/util/fs-safe.mjs";
import { testCandidate as createCandidate, makeRepo, testTempDir } from "./helpers.mjs";

/** @type {import("../src/adapters/contract.mjs").Invocation} */
const invocation = {
  role: "implementer",
  model: "model-x",
  effort: "high",
  systemPrompt: "system",
  taskPrompt: "task",
  bundle: {},
  sessionDir: "/tmp/session",
  sessionFile: "/tmp/session/session.json",
  cwd: "/tmp",
  timeoutMs: 1000,
};

test("codex runs read-only with every non-harness capability disabled", () => {
  const args = codexArgs(invocation, "codex");
  for (const flag of ["--ephemeral", "--ignore-user-config", "--json"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "multi_agent",
    "computer_use",
    "browser_use",
  ]) {
    assert.ok(DISABLED_FEATURES.includes(feature), feature);
    assert.ok(args.includes(feature));
  }
  assert.ok(!DISABLED_FEATURES.includes("code_mode_host"), "code mode routes tool calls and must stay on");
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.some((arg) => arg.includes('PANAGENT_SESSION = "/tmp/session/session.json"')));
  assert.equal(args.at(-1), "-");
});

test("codex events outside the harness are policy violations", () => {
  const state = { usage: null, errors: [] };
  inspectCodexEvent(
    { type: "item.completed", item: { type: "mcp_tool_call", server: "panagent", tool: "read_files" } },
    state,
  );
  inspectCodexEvent(
    { type: "item.completed", item: { type: "mcp_tool_call", server: "codex", tool: "list_mcp_resources" } },
    state,
  );
  inspectCodexEvent({ type: "turn.completed", usage: { input_tokens: 10 } }, state);
  assert.equal(/** @type {any} */ (state.usage).input_tokens, 10);
  for (const item of [
    { type: "command_execution", command: "ls" },
    { type: "file_change" },
    { type: "web_search" },
    { type: "collab_tool_call" },
    { type: "mcp_tool_call", server: "github", tool: "merge" },
  ]) {
    assert.throws(
      () => inspectCodexEvent({ type: "item.started", item }, state),
      (error) => error.errorClass === "policy_violation",
      item.type,
    );
  }
});

test("claude runs with no built-in tools and checks its init tool list", () => {
  const args = claudeArgs(invocation, "/tmp/mcp.json");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__panagent__*");
  const state = { usage: null, model: null, result: null, toolsChecked: false };
  inspectClaudeEvent(
    {
      type: "system",
      subtype: "init",
      tools: ["mcp__panagent__read_files"],
      mcp_servers: [{ name: "panagent", status: "connected" }],
      model: "m",
    },
    state,
  );
  assert.equal(state.toolsChecked, true);
  assert.throws(
    () => inspectClaudeEvent({ type: "system", subtype: "init", tools: ["Bash", "mcp__panagent__x"] }, state),
    /outside the harness: Bash/,
  );
  assert.throws(
    () =>
      inspectClaudeEvent(
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }] } },
        state,
      ),
    (error) => error.errorClass === "policy_violation",
  );
  assert.throws(
    () =>
      inspectClaudeEvent(
        { type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "panagent", status: "failed" }] },
        state,
      ),
    /status: failed/,
  );
});

test("claude usage includes cache creation and cache read tokens in input totals", () => {
  assert.deepEqual(
    claudeUsage({
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
      },
      total_cost_usd: 0.12,
    }),
    { input_tokens: 1125, cached_input_tokens: 1000, output_tokens: 50, cost_usd: 0.12 },
  );
});

test("claude usage defaults missing fields to zero and missing cost to null", () => {
  for (const [usage, inputTokens, cachedTokens] of [
    [{}, 0, 0],
    [{ input_tokens: 25 }, 25, 0],
    [{ cache_creation_input_tokens: 100 }, 100, 0],
    [{ cache_read_input_tokens: 1000 }, 1000, 1000],
  ]) {
    assert.deepEqual(claudeUsage({ usage }), {
      input_tokens: inputTokens,
      cached_input_tokens: cachedTokens,
      output_tokens: 0,
      cost_usd: null,
    });
  }
  assert.equal(claudeUsage({ usage: {}, total_cost_usd: 0 }).cost_usd, 0);
});

test("claude usage is null when the result has no usage", () => {
  assert.equal(claudeUsage({}), null);
  assert.equal(claudeUsage({ usage: null, total_cost_usd: 0.12 }), null);
});

test("pi runs with built-ins, extensions, skills, and context files disabled", () => {
  const args = piArgs(invocation, "openai-codex");
  for (const flag of [
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-session",
    "--no-approve",
  ])
    assert.ok(args.includes(flag), flag);
  assert.match(args[args.indexOf("--tools") + 1], /^read_files,.*submit_result$/);
  const state = {
    allowed: new Set(["read_files"]),
    usage: null,
    model: null,
    provider: null,
    providerError: null,
  };
  assert.throws(
    () => inspectPiEvent({ type: "tool_execution_start", toolName: "bash" }, state),
    /outside the harness/,
  );
  inspectPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "The usage limit has been reached",
        usage: { input: 5, output: 1 },
      },
    },
    state,
  );
  assert.match(String(state.providerError), /usage limit/);
});

test("provider messages about limits pause instead of failing", () => {
  assert.deepEqual(classifyProviderMessage("Codex error: The usage limit has been reached"), {
    errorClass: "usage_limited",
    retryAfter: null,
  });
  assert.equal(classifyProviderMessage("You've hit your limit. Try again at 9:15 PM.").retryAfter, "9:15 PM");
  assert.equal(classifyProviderMessage("429 Too Many Requests").errorClass, "usage_limited");
  assert.equal(classifyProviderMessage("internal server error").errorClass, "provider");
  assert.ok(compareVersions("1.0.2", "0.84.3") > 0);
  assert.ok(compareVersions("2.1.121", "2.1.289") < 0);
});

/** Write an executable node script. @param {string} body */
function script(body) {
  const dir = testTempDir("fake-runtime");
  const file = path.join(dir, "runtime.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

test("runJsonlProcess streams events, kills on violation, and times out", async () => {
  const emitter = script(
    'process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({ n: 1 })); console.log("not json"); console.log(JSON.stringify({ n: 2 })); });',
  );
  const seen = [];
  const done = await runJsonlProcess({
    command: emitter,
    args: [],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    input: "x",
    timeoutMs: 10000,
    onEvent: (event) => seen.push(event.n),
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(done.nonJsonLines, 1);

  const forever = script("console.log(JSON.stringify({ bad: true })); setInterval(() => {}, 1000);");
  await assert.rejects(
    runJsonlProcess({
      command: forever,
      args: [],
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      input: "",
      timeoutMs: 10000,
      onEvent: () => {
        throw new HarnessError("policy_violation", "test", "stop");
      },
    }),
    (error) => error.errorClass === "policy_violation",
  );
  const sleeper = script("setInterval(() => {}, 1000);");
  await assert.rejects(
    runJsonlProcess({
      command: sleeper,
      args: [],
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      input: "",
      timeoutMs: 300,
      onEvent: () => {},
    }),
    (error) => error.errorClass === "infra" && error.code === "timeout",
  );
});

test("the MCP tool server lists role tools and serves calls over stdio", async () => {
  const repo = makeRepo();
  const candidate = createCandidate(repo.root, "main");
  const sessionDir = testTempDir("mcp");
  const sessionFile = path.join(sessionDir, "session.json");
  writeJsonAtomic(sessionFile, {
    version: 1,
    role: "implementer",
    root: candidate.root,
    repository_root: repo.root,
    base_commit: candidate.base_commit,
    allowed_paths: ["src/"],
    read_only_paths: [],
    protected_paths: [],
    forbidden_paths: ["private/"],
    deleted_paths: [],
    run_checks: [],
    max_tool_calls: 20,
    max_run_check_calls: 0,
    sandbox_backend: "none",
    project: normalizeProjectConfig({ version: 1, checks: {} }, repo.root),
    session_dir: sessionDir,
  });
  const entry = fileURLToPath(new URL("../src/adapters/mcp-server-main.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PANAGENT_SESSION: sessionFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      if (message.id !== undefined) responses.set(message.id, message);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const response = async (id) => {
    for (let i = 0; i < 100 && !responses.has(id); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return responses.get(id);
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const init = await response(1);
    assert.equal(init.result.serverInfo.name, "panagent");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (await response(2)).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "apply_patch",
      "read_base_file",
      "read_file_range",
      "read_files",
      "run_check",
      "search_code",
      "stat_paths",
      "submit_result",
    ]);
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_files", arguments: { paths: ["private/secret.txt"] } },
    });
    const denied = (await response(3)).result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /not readable/);
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "apply_patch",
        arguments: { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] },
      },
    });
    assert.equal((await response(4)).result.isError ?? false, false);
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "submit_result", arguments: { summary: "via mcp" } },
    });
    assert.match((await response(5)).result.content[0].text, /accepted/);
  } finally {
    child.kill();
    candidate.cleanup();
    repo.cleanup();
  }
});
