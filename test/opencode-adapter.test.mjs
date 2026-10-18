// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adapterForRole } from "../src/adapters/index.mjs";
import {
  assertNoMachineConfig,
  createOpencodeAdapter,
  inspectOpencodeEvent,
  machineConfigPaths,
  opencodeConfig,
  opencodeState,
  secretLookingPath,
  validateOpencodeConfig,
} from "../src/adapters/opencode/index.mjs";
import { toolDefinitions } from "../src/tools/definitions.mjs";

/** Synthetic executable only; no real CLI or network.
 * @param {string} [behavior] @param {string} [version]
 */
function fixture(behavior = "", version = "1.19.3") {
  const root = mkdtempSync(path.join(os.tmpdir(), "apocha-opencode-test-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const sessionFile = path.join(root, "session.json");
  writeFileSync(sessionFile, JSON.stringify({ repository_root: repo }));
  const report = path.join(root, "report.json");
  const command = path.join(root, "opencode");
  const script = [
    "#!" + process.execPath,
    'const fs = require("node:fs"); const path = require("node:path");',
    "const args = process.argv.slice(2);",
    "const report = " + JSON.stringify(report) + ";",
    'const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));',
    'const phase = args.includes("--version") ? "version" : args.includes("debug") ? "debug" : "run";',
    "fs.writeFileSync(report, JSON.stringify({phase,args,env:process.env,cwd:process.cwd(),config,mode:fs.statSync(path.dirname(process.env.OPENCODE_CONFIG)).mode & 511}));",
    behavior,
    'if (phase === "version") { console.log(' + JSON.stringify(version) + "); }",
    'else if (phase === "debug") { console.log(JSON.stringify(config, null, 2)); }',
    'else { let input = ""; process.stdin.on("data", x => input += x); process.stdin.on("end", () => {',
    "const data = JSON.parse(fs.readFileSync(report)); fs.writeFileSync(report, JSON.stringify({...data,input}));",
    'console.log(JSON.stringify({type:"text",part:{text:"complete"}}));',
    'console.log(JSON.stringify({type:"step_finish",part:{id:"s1",tokens:{input:3,output:2},cost:0.1}}));',
    "}); }",
  ].join("\n");
  writeFileSync(command, script, { mode: 0o700 });
  /** @type {import("../src/adapters/contract.mjs").Invocation} */
  const invocation = {
    role: "implementer",
    model: "opencode/synthetic-free",
    provider: "synthetic-vendor",
    variant: "reasoning",
    effort: "high",
    systemPrompt: "synthetic system",
    taskPrompt: "synthetic task",
    bundle: {},
    sessionDir: root,
    sessionFile,
    cwd: repo,
    timeoutMs: 5000,
  };
  return {
    root,
    repo,
    command,
    report,
    invocation,
    read: () => JSON.parse(readFileSync(report, "utf8")),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
/** @param {string} code */
const fails = (code) => (error) => error.code === code;

test("factory, version probe and exact isolated MCP policy for both roles", async () => {
  const f = fixture();
  const ambient = {
    OPENCODE_CONFIG_CONTENT: '{"plugin":["malicious"]}',
    OPENAI_API_KEY: "secret-token",
    OPENCODE_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
  };
  const prior = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ambient);
  try {
    const adapter = adapterForRole(
      /** @type {any} */ ({
        roles: { implementer: { adapter: "opencode" } },
        adapters: { opencode: { command: f.command } },
      }),
      "implementer",
    );
    const probe = await adapter.probe();
    assert.equal(probe.ok, true);
    assert.equal(probe.version, "1.19.3");
    assert.match(probe.problems.join(" "), /Experimental/);
    assert.equal(existsSync(f.read().env.HOME), false);
    for (const role of /** @type {const} */ (["implementer", "reviewer"])) {
      const result = await adapter.run({ ...f.invocation, role });
      const data = f.read();
      assert.equal(result.runtime.adapter, "opencode");
      assert.equal(result.runtime.provider, "synthetic-vendor");
      assert.equal(result.runtime.model, f.invocation.model);
      assert.equal(result.final_message, "complete");
      assert.equal(result.usage?.input_tokens, 3);
      assert.equal(result.usage?.cache_write_tokens, null);
      assert.equal(data.input, "synthetic task");
      assert.deepEqual(data.args, [
        "--pure",
        "run",
        "--format",
        "json",
        "--agent",
        "apocha",
        "-m",
        f.invocation.model,
        "--variant",
        "reasoning",
      ]);
      assert.equal(data.mode, 0o700);
      const names = toolDefinitions(role).map((t) => "apocha_" + t.name);
      const permissions = Object.fromEntries([["*", "deny"], ...names.map((n) => [n, "allow"])]);
      assert.deepEqual(data.config.permission, permissions);
      assert.deepEqual(data.config.agent.apocha.permission, permissions);
      for (const builtin of [
        "read",
        "write",
        "execute",
        "task",
        "bash",
        "shell",
        "apply_patch",
        "future_builtin",
      ])
        assert.equal(data.config.permission[builtin] ?? data.config.permission["*"], "deny");
      assert.equal(data.config.agent.apocha.prompt, "synthetic system");
      const mcp = data.config.mcp.apocha;
      assert.equal(mcp.command[0], process.execPath);
      assert.equal(path.isAbsolute(mcp.command[1]), true);
      assert.match(mcp.command[1], /mcp-server-main.mjs$/);
      assert.deepEqual(mcp.environment, { APOCHA_SESSION: f.invocation.sessionFile });
      assert.deepEqual(data.config.enabled_providers, ["opencode"]);
      const expected = opencodeConfig({ ...f.invocation, role });
      validateOpencodeConfig(data.config, expected);
      assert.throws(
        () => validateOpencodeConfig({ ...data.config, tools: { read: true } }, expected),
        fails("opencode_config_contamination"),
      );
      for (const key of Object.keys(ambient)) assert.equal(data.env[key], undefined);
      assert.equal(data.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      for (const key of [
        "HOME",
        "OPENCODE_TEST_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
        "OPENCODE_CONFIG",
      ]) {
        assert.equal(path.isAbsolute(data.env[key]), true);
        assert.equal(existsSync(data.env[key]), false);
      }
      assert.equal(existsSync(data.cwd), false);
    }
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    f.clean();
  }
});

test("reject unsupported versions, authentication and unknown vendor before CLI", async () => {
  for (const version of ["1.19.2", "1.19.4", "2.0.0"]) {
    const f = fixture("", version);
    try {
      assert.equal((await createOpencodeAdapter({ command: f.command }).probe()).ok, false);
      await assert.rejects(
        createOpencodeAdapter({ command: f.command }).run(f.invocation),
        fails("opencode_version"),
      );
      assert.equal(existsSync(f.read().env.HOME), false);
    } finally {
      f.clean();
    }
  }
  const f = fixture();
  try {
    for (const provider of [undefined, "opencode", "unknown"])
      await assert.rejects(
        createOpencodeAdapter({ command: f.command }).run({ ...f.invocation, provider }),
        fails("opencode_unknown_vendor"),
      );
    await assert.rejects(
      createOpencodeAdapter({ command: f.command }).run({ ...f.invocation, model: "vendor/model" }),
      fails("opencode_unsupported_auth"),
    );
    assert.equal(existsSync(f.report), false);
    await createOpencodeAdapter({ command: f.command, provider: "actual" }).run({
      ...f.invocation,
      provider: undefined,
      variant: undefined,
    });
    assert.equal(f.read().args.at(-1), "high");
  } finally {
    f.clean();
  }
});

test("machine policy existence and secret-looking source paths fail closed", async () => {
  const f = fixture();
  try {
    const machine = path.join(f.root, "machine");
    mkdirSync(machine);
    assert.throws(() => assertNoMachineConfig([machine]), fails("opencode_machine_config"));
    assert.deepEqual(machineConfigPaths("linux"), ["/etc/opencode"]);
    assert.equal(machineConfigPaths("darwin", "operator").length, 3);
    assert.match(machineConfigPaths("win32", "operator", "C:\\ProgramData")[0], /opencode$/);
    for (const name of [".env", ".env.production", "x.pem", "x.key", "id_rsa", "id_ed25519.pub"]) {
      assert.equal(secretLookingPath(name), true);
      writeFileSync(path.join(f.repo, name), "synthetic");
      await assert.rejects(
        createOpencodeAdapter({ command: f.command }).run(f.invocation),
        fails("opencode_source_privacy"),
      );
      assert.equal(spawnSync("git", ["-C", f.repo, "add", "--", name]).status, 0);
      await assert.rejects(
        createOpencodeAdapter({ command: f.command }).run(f.invocation),
        fails("opencode_source_privacy"),
      );
      spawnSync("git", ["-C", f.repo, "rm", "--cached", "--", name]);
      rmSync(path.join(f.repo, name));
    }
    assert.equal(existsSync(f.report), false);
    assert.equal(secretLookingPath(".env.example"), false);
    for (const name of ["example.key", "id_rsa.template"]) assert.equal(secretLookingPath(name), true);
  } finally {
    f.clean();
  }
});

test("preflight rejects contamination, falsified config and malformed pretty JSON", async () => {
  for (const mutation of [
    'config.mcp.other = {type:"local",command:["bad"]}',
    'config.permission["*"] = "ask"',
    'config.agent.apocha.permission.read = "allow"',
    'config.agent.apocha.prompt = "bad"',
    'config.plugin = ["bad"]',
    'config.instructions = ["bad"]',
    "config.lsp = {}",
    "config.formatter = {}",
    'config.share = "auto"',
    "config.snapshot = true",
    'config.default_agent = "build"',
    'config.enabled_providers.push("other")',
  ]) {
    const f = fixture(
      'if (phase === "debug") { ' +
        mutation +
        "; console.log(JSON.stringify(config,null,2)); process.exit(0); }",
    );
    try {
      await assert.rejects(
        createOpencodeAdapter({ command: f.command }).run(f.invocation),
        fails("opencode_config_contamination"),
      );
      assert.equal(f.read().phase, "debug");
      assert.equal(existsSync(f.read().env.HOME), false);
    } finally {
      f.clean();
    }
  }
  for (const behavior of [
    'if (phase === "debug") { fs.writeFileSync(process.env.OPENCODE_CONFIG, "{}"); }',
    'if (phase === "debug") { console.log("invalid"); process.exit(0); }',
    'if (phase === "debug") { console.log("x".repeat(1100000)); process.exit(0); }',
  ]) {
    const f = fixture(behavior);
    try {
      await assert.rejects(createOpencodeAdapter({ command: f.command }).run(f.invocation));
      assert.equal(f.read().phase, "debug");
      assert.equal(existsSync(f.read().env.HOME), false);
    } finally {
      f.clean();
    }
  }
});

test("foreign tools including denied builtins, prefix spoofing and raw events are violations", () => {
  for (const tool of [
    "read",
    "execute",
    "task",
    "apply_patch",
    "apocha_submit_result_spoof",
    "apocha_apply_patch",
  ]) {
    for (const event of [
      { type: "tool_use", part: { tool, state: { status: "error" } } },
      { type: "message.part.updated", properties: { part: { type: "tool", tool } } },
      { type: "unknown_tool_event", tool },
      { type: "future_capability", tool },
    ]) {
      const state = opencodeState();
      state.allowed.add("apocha_submit_result");
      assert.throws(() => inspectOpencodeEvent(event, state), fails("opencode_foreign_tool"));
    }
  }
  const state = opencodeState();
  state.allowed.add("apocha_submit_result");
  inspectOpencodeEvent({ type: "tool_use", part: { tool: "apocha_submit_result" } }, state);
  inspectOpencodeEvent({ type: "future_info" }, state);
  assert.equal(state.known, 1);
});

test("usage deduplicates steps, preserves unknown costs and bounds final text", () => {
  const state = opencodeState();
  const step = {
    type: "step_finish",
    part: {
      id: "a",
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.2,
    },
  };
  inspectOpencodeEvent(step, state);
  inspectOpencodeEvent(step, state);
  inspectOpencodeEvent({ type: "step_finish", part: { id: "b", tokens: { input: 2 }, cost: 0.1 } }, state);
  assert.deepEqual(state.usage, {
    input_tokens: 12,
    output_tokens: 4,
    reasoning_tokens: 2,
    cached_input_tokens: 3,
    cache_write_tokens: 1,
    cost_usd: 0.30000000000000004,
  });
  const unknown = opencodeState();
  inspectOpencodeEvent({ type: "step_finish", part: { id: "a", tokens: { input: 1 } } }, unknown);
  assert.equal(unknown.usage.cost_usd, null);
  inspectOpencodeEvent({ type: "text", part: { text: "x".repeat(3000) } }, state);
  assert.equal(state.final_message?.length, 2000);
});

test("provider errors sanitized and classified; unknown streams and exits fail", async () => {
  for (const [stream, code, errorClass] of [
    [
      'console.log(JSON.stringify({type:"error",error:{data:{message:"429 try again at tomorrow\\nBearer secret-token"}}}));',
      "opencode_provider_error",
      "usage_limited",
    ],
    [
      'console.log(JSON.stringify({type:"error",error:{data:{message:"HTTP403 free tier only usable within OpenCode token=secret"}}}));',
      "opencode_provider_error",
      "provider",
    ],
    ['console.log("not JSON");', "opencode_unknown_stream", "tool_protocol"],
    ['console.log(JSON.stringify({type:"future_info"}));', "opencode_unknown_stream", "tool_protocol"],
    ["process.exitCode=1;", "opencode_exit", "infra"],
    [
      'console.log(JSON.stringify({type:"tool_use",part:{tool:"read"}}));',
      "opencode_foreign_tool",
      "policy_violation",
    ],
  ]) {
    const f = fixture('if (phase === "run") { ' + stream + " process.exit(process.exitCode || 0); }");
    try {
      await assert.rejects(createOpencodeAdapter({ command: f.command }).run(f.invocation), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.errorClass, errorClass);
        assert.doesNotMatch(error.message, /secret-token|token=secret|synthetic system/);
        if (errorClass === "usage_limited") assert.equal(error.retryAfter, "tomorrow");
        return true;
      });
      assert.equal(existsSync(f.read().env.HOME), false);
    } finally {
      f.clean();
    }
  }
});

test("timeout and abort clean private directories during preflight and runtime", async () => {
  for (const phase of ["debug", "run"]) {
    for (const abort of [false, true]) {
      const f = fixture(
        "if (phase === " + JSON.stringify(phase) + ") { setInterval(() => {},1000); return; }",
      );
      const controller = new AbortController();
      const timer = abort
        ? setInterval(() => {
            if (existsSync(f.report) && f.read().phase === phase) controller.abort();
          }, 10)
        : undefined;
      try {
        await assert.rejects(
          createOpencodeAdapter({ command: f.command }).run({
            ...f.invocation,
            timeoutMs: abort ? 5000 : 1200,
            signal: controller.signal,
          }),
          fails(abort ? "aborted" : "timeout"),
        );
        const data = f.read();
        assert.equal(existsSync(data.env.HOME), false);
        assert.equal(existsSync(data.cwd), false);
      } finally {
        clearInterval(timer);
        f.clean();
      }
    }
  }
});
