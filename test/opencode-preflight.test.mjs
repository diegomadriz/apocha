// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOpencodeAdapter,
  opencodeConfig,
  secretLookingPath,
  validateOpencodeConfig,
} from "../src/adapters/opencode/index.mjs";

/** Fake CLI only: no installed OpenCode, credentials, or network.
 * @param {string} [debugMutation]
 */
function fixture(debugMutation = "") {
  const root = mkdtempSync(path.join(os.tmpdir(), "apocha-preflight-test-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const sessionFile = path.join(root, "session.json");
  writeFileSync(sessionFile, JSON.stringify({ repository_root: repo }));
  const command = path.join(root, "opencode");
  const ran = path.join(root, "ran");
  writeFileSync(
    command,
    [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      'if (process.argv.includes("--version")) { console.log("1.19.3"); process.exit(0); }',
      'const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));',
      'if (process.argv.includes("debug")) {',
      'config.$schema = "https://opencode.ai/config.json"; config.username = "synthetic";',
      "config.mode = {}; config.command = {}; config.agent.apocha.options = {};",
      debugMutation,
      "console.log(JSON.stringify(config, null, 2));",
      "} else {",
      "fs.writeFileSync(" + JSON.stringify(ran) + ', "ran");',
      'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({type:"text",part:{text:"complete"}})));',
      "}",
    ].join("\n"),
    { mode: 0o700 },
  );
  /** @type {import("../src/adapters/contract.mjs").Invocation} */
  const invocation = {
    role: "implementer",
    model: "opencode/synthetic-free",
    provider: "synthetic-vendor",
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
    invocation,
    ran,
    adapter: createOpencodeAdapter({ command }),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {any} error */
const contamination = (error) => error.code === "opencode_config_contamination";

/** Actual-shaped isolated V1.19.3 debug config, with generated policy retained.
 * @param {any} expected
 */
function resolvedConfig(expected) {
  const resolved = structuredClone(expected);
  resolved.$schema = "https://opencode.ai/config.json";
  resolved.username = "synthetic";
  resolved.mode = {};
  resolved.command = {};
  resolved.agent.apocha.options = {};
  return resolved;
}

test("V1.19.3 empty debug defaults pass preflight and reach the fake model", async () => {
  const f = fixture();
  try {
    const result = await f.adapter.run(f.invocation);
    assert.equal(result.final_message, "complete");
    assert.equal(existsSync(f.ran), true);
    const expected = opencodeConfig(f.invocation);
    const resolved = resolvedConfig(expected);
    const before = structuredClone(resolved);
    validateOpencodeConfig(resolved, expected);
    assert.deepEqual(resolved, before);
    assert.equal(Object.hasOwn(expected, "mode"), false);
    assert.equal(Object.hasOwn(expected.agent.apocha, "options"), false);
    validateOpencodeConfig(expected, expected);
  } finally {
    f.clean();
  }
});

test("only absent exact empty plain defaults are canonicalized", () => {
  const f = fixture();
  try {
    const expected = opencodeConfig(f.invocation);
    for (const keys of [["mode"], ["command"], ["agent", "apocha", "options"]]) {
      for (const value of [
        { poison: true },
        { nested: {} },
        [],
        [{}],
        null,
        false,
        "",
        0,
        new Date(0),
        Object.create({ inherited: true }),
        Object.defineProperty({}, "hidden", { value: true }),
        { [Symbol("poison")]: true },
      ]) {
        const resolved = resolvedConfig(expected);
        let parent = resolved;
        for (const key of keys.slice(0, -1)) parent = parent[key];
        parent[keys[keys.length - 1]] = value;
        assert.throws(
          () => validateOpencodeConfig(resolved, expected),
          contamination,
          keys.join(".") + " must reject " + String(value),
        );
      }
      const explicit = resolvedConfig(expected);
      delete explicit.$schema;
      delete explicit.username;
      let parent = explicit;
      for (const key of keys.slice(0, -1)) parent = parent[key];
      parent[keys[keys.length - 1]] = { required: true };
      assert.throws(() => validateOpencodeConfig(resolvedConfig(expected), explicit), contamination);
      // When expected explicitly includes defaults, they must be preserved for equality.
      const allDefaults = resolvedConfig(expected);
      delete allDefaults.$schema;
      delete allDefaults.username;
      validateOpencodeConfig(resolvedConfig(expected), allDefaults);
    }
  } finally {
    f.clean();
  }
});

test("empty debug defaults do not mask policy or unknown-field contamination", () => {
  const f = fixture();
  try {
    const expected = opencodeConfig(f.invocation);
    /** @type {Array<(config: any) => void>} */
    const poisons = [
      (c) => {
        c.agent.foreign = {};
      },
      (c) => {
        c.agent.apocha.extra = {};
      },
      (c) => {
        c.agent.options = {};
      },
      (c) => {
        c.options = {};
      },
      (c) => {
        c.provider = { opencode: { options: { baseURL: "https://invalid" } } };
      },
      (c) => {
        c.mcp.other = { type: "local", command: ["bad"] };
      },
      (c) => {
        c.plugin = ["bad"];
      },
      (c) => {
        c.instructions = ["bad"];
      },
      (c) => {
        c.permission["*"] = "ask";
      },
      (c) => {
        c.agent.apocha.permission.read = "allow";
      },
      (c) => {
        c.agent.apocha.prompt = "bad";
      },
      (c) => {
        c.agent.apocha.mode = {};
      },
      (c) => {
        c.enabled_providers.push("other");
      },
      (c) => {
        c.lsp = {};
      },
      (c) => {
        c.formatter = {};
      },
      (c) => {
        c.autoupdate = true;
      },
      (c) => {
        c.share = "auto";
      },
      (c) => {
        c.snapshot = true;
      },
      (c) => {
        c.default_agent = "build";
      },
      (c) => {
        c.mcp.apocha.environment.EXTRA = "bad";
      },
      (c) => {
        c.unknown = {};
      },
    ];
    for (const poison of poisons) {
      const resolved = resolvedConfig(expected);
      poison(resolved);
      assert.throws(() => validateOpencodeConfig(resolved, expected), contamination);
    }
  } finally {
    f.clean();
  }
});

test("accepted debug defaults cannot conceal private on-disk policy mutation", async () => {
  const f = fixture(
    'const disk = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));' +
      'disk.permission["*"] = "allow"; fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify(disk));',
  );
  try {
    await assert.rejects(f.adapter.run(f.invocation), contamination);
    assert.equal(existsSync(f.ran), false);
  } finally {
    f.clean();
  }
});

test("template labels cannot hide tracked key PEM or SSH source filenames", async () => {
  const f = fixture();
  try {
    for (const name of [
      "deploy-example.key",
      "template.pem",
      "id_rsa.example",
      "id_ed25519.sample",
      "sample.key",
      "example.pem",
      "id_rsa.template",
    ]) {
      assert.equal(secretLookingPath(name), true, name);
      writeFileSync(path.join(f.repo, name), "synthetic");
      assert.equal(spawnSync("git", ["-C", f.repo, "add", "--", name]).status, 0);
      await assert.rejects(f.adapter.run(f.invocation), (error) => error.code === "opencode_source_privacy");
      assert.equal(existsSync(f.ran), false);
      assert.equal(spawnSync("git", ["-C", f.repo, "rm", "--cached", "--", name]).status, 0);
      rmSync(path.join(f.repo, name));
    }
  } finally {
    f.clean();
  }
});

test("only exact tracked env template names are exempt from the filename heuristic", async () => {
  const f = fixture();
  try {
    for (const name of [".env.example", ".env.sample", ".env.template"]) {
      assert.equal(secretLookingPath(name), false, name);
      writeFileSync(path.join(f.repo, name), "PUBLIC_SYNTHETIC=placeholder\n");
      assert.equal(spawnSync("git", ["-C", f.repo, "add", "--", name]).status, 0);
    }
    for (const name of [
      ".env.example.key",
      ".env.sample.local",
      ".env.production.template",
      ".env.template.pem",
      "id_rsa.env.example",
      "id_ed25519.template",
    ]) {
      assert.equal(secretLookingPath(name), true, name);
    }
    const result = await f.adapter.run(f.invocation);
    assert.equal(result.final_message, "complete");
    assert.equal(readFileSync(f.ran, "utf8"), "ran");
  } finally {
    f.clean();
  }
});
