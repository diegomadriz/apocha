// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpencodeAdapter } from "../src/adapters/opencode/index.mjs";
import { liveProbe, opencodeSourcePrivacyProbe } from "../src/cli/probe.mjs";
import { normalizeRuntimeConfig } from "../src/config/runtime.mjs";
import { rolePrompt } from "../src/stages/invoke.mjs";
import { toolDefinitions } from "../src/tools/definitions.mjs";
import { createProjectTools } from "../src/tools/project-tools.mjs";
import { git } from "../src/util/git.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));

function runtimes(effort, variant) {
  const options = {
    ...(effort === undefined ? {} : { effort }),
    ...(variant === undefined ? {} : { variant }),
  };
  return normalizeRuntimeConfig(
    {
      version: 1,
      roles: {
        implementer: { adapter: "opencode", model: "opencode/free", provider: "vendor-a", ...options },
        reviewer: { adapter: "opencode", model: "opencode/free", provider: "vendor-b", ...options },
      },
    },
    "synthetic",
  );
}

/** @param {string} root @param {string} mode */
function executable(root, mode) {
  const command = path.join(root, "opencode");
  writeFileSync(
    command,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(path.join(root, "calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) console.log("1.19.3");
else if (process.argv.includes("debug")) console.log(readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
else console.log(JSON.stringify(${mode === "foreign" ? '{ type: "tool_use", tool: "bash", state: { status: "denied" } }' : '{ type: "error", error: { data: { message: "HTTP403 forbidden" } } }'}));
`,
  );
  chmodSync(command, 0o700);
  return command;
}

for (const role of /** @type {const} */ (["implementer", "reviewer"])) {
  test(`opencode synthetic ${role} uses actual role, schema, session and exact variant`, async () => {
    for (const [effort, variant] of [
      [undefined, undefined],
      ["high", "custom-free-variant"],
    ]) {
      const runtime = runtimes(effort, variant);
      const adapter = {
        name: "opencode",
        async probe() {
          return { adapter: "opencode", command: "", version: null, ok: true, problems: [] };
        },
        async run(invocation) {
          assert.equal(invocation.role, role);
          assert.equal(invocation.effort, effort);
          assert.equal(invocation.variant, variant);
          assert.equal(invocation.systemPrompt, rolePrompt(role));
          assert.match(invocation.taskPrompt, /escaped.txt/);
          assert.match(invocation.taskPrompt, /\/etc\/hosts/);
          const session = JSON.parse(readFileSync(invocation.sessionFile, "utf8"));
          assert.equal(session.role, role);
          const tools = createProjectTools(session);
          assert.deepEqual(new Set(tools.names), new Set(toolDefinitions(role).map((tool) => tool.name)));
          if (role === "reviewer") {
            assert.equal(tools.names.includes("apply_patch"), false);
            assert.equal(tools.names.includes("run_check"), false);
            assert.deepEqual(session.allowed_paths, []);
            assert.deepEqual(session.read_only_paths, ["probe.txt"]);
            const schema = toolDefinitions(role).find((tool) => tool.name === "submit_result")?.inputSchema;
            assert.ok(schema?.required.includes("candidate_digest"));
            assert.equal((await tools.call("submit_result", { decision: "PASS", findings: [] })).ok, false);
            assert.equal((await tools.call("read_files", { paths: ["probe.txt"] })).ok, true);
            assert.equal(
              (
                await tools.call("submit_result", {
                  decision: "PASS",
                  findings: [],
                  candidate_digest: invocation.bundle.candidate.candidate_digest,
                })
              ).ok,
              true,
            );
          } else {
            assert.equal(
              (
                await tools.call("apply_patch", {
                  edits: [{ path: "probe.txt", old_text: "", new_text: "ok" }],
                })
              ).ok,
              true,
            );
            assert.equal(
              (await tools.call("submit_result", { summary: "denied".repeat(100), criteria_evidence: [] }))
                .ok,
              true,
            );
          }
          return /** @type {any} */ ({});
        },
      };
      const result = await liveProbe(adapter, runtime, role);
      assert.equal(result.ok, true, result.detail);
      assert.ok(result.detail.length < 300);
    }
  });
}

for (const mode of [
  "escape",
  "mutation",
  "committed-mutation",
  "ignored-mutation",
  "no-read",
  "digest",
  "foreign-trace",
]) {
  test(`opencode reviewer rejects ${mode}`, async () => {
    const adapter = {
      name: "opencode",
      async probe() {
        return /** @type {any} */ ({});
      },
      async run(invocation) {
        const session = JSON.parse(readFileSync(invocation.sessionFile, "utf8"));
        const tools = createProjectTools(session);
        if (mode !== "no-read") await tools.call("read_files", { paths: ["probe.txt"] });
        if (mode === "escape") writeFileSync(path.join(invocation.cwd, "escaped.txt"), "escaped");
        if (mode === "mutation" || mode === "committed-mutation") {
          writeFileSync(path.join(session.root, "README.md"), "changed");
          if (mode === "committed-mutation") {
            git(session.root, [
              "-c",
              "user.name=probe",
              "-c",
              "user.email=probe@localhost",
              "commit",
              "-qam",
              "changed",
            ]);
          }
        }
        if (mode === "ignored-mutation") {
          writeFileSync(path.join(session.root, ".git", "info", "exclude"), "hidden.txt\n");
          writeFileSync(path.join(session.root, "hidden.txt"), "changed");
        }
        if (mode === "foreign-trace") await tools.call("apply_patch", { edits: [] });
        await tools.call("submit_result", {
          decision: "PASS",
          findings: [],
          candidate_digest: mode === "digest" ? "0".repeat(64) : invocation.bundle.candidate.candidate_digest,
        });
        return /** @type {any} */ ({});
      },
    };
    assert.equal((await liveProbe(adapter, runtimes(undefined, undefined), "reviewer")).ok, false);
  });
}

for (const mode of ["escape-repo", "escape-cwd", "no-patch", "wrong-content", "blocked", "foreign-trace"]) {
  test(`opencode implementer rejects ${mode}`, async () => {
    const adapter = {
      name: "opencode",
      async probe() {
        return /** @type {any} */ ({});
      },
      async run(invocation) {
        const session = JSON.parse(readFileSync(invocation.sessionFile, "utf8"));
        const tools = createProjectTools(session);
        if (mode !== "no-patch") {
          await tools.call("apply_patch", {
            edits: [{ path: "probe.txt", old_text: "", new_text: mode === "wrong-content" ? "wrong" : "ok" }],
          });
        }
        if (mode.startsWith("escape-")) {
          writeFileSync(
            path.join(mode === "escape-repo" ? session.root : invocation.cwd, "escaped.txt"),
            "escaped",
          );
        }
        if (mode === "foreign-trace") await tools.call("shell", { command: "cat /etc/hosts" });
        await tools.call(
          "submit_result",
          mode === "blocked"
            ? { status: "blocked", summary: "synthetic", blocked_reason: "synthetic" }
            : { summary: "synthetic", criteria_evidence: [] },
        );
        return /** @type {any} */ ({});
      },
    };
    assert.equal((await liveProbe(adapter, runtimes(undefined, undefined), "implementer")).ok, false);
  });
}

test("other adapters retain low-effort implementer probes for configured reviewers", async () => {
  const adapter = {
    name: "fake",
    async probe() {
      return /** @type {any} */ ({});
    },
    async run(invocation) {
      assert.equal(invocation.role, "implementer");
      assert.equal(invocation.effort, "low");
      assert.equal(invocation.variant, undefined);
      const tools = createProjectTools(JSON.parse(readFileSync(invocation.sessionFile, "utf8")));
      await tools.call("apply_patch", { edits: [{ path: "probe.txt", old_text: "", new_text: "ok" }] });
      await tools.call("submit_result", { summary: "synthetic", criteria_evidence: [] });
      return /** @type {any} */ ({});
    },
  };
  assert.equal((await liveProbe(adapter, runtimes("high", "custom"), "reviewer")).ok, true);
});

for (const mode of ["foreign", "provider"]) {
  test(`opencode executable ${mode} failure cannot pass lockdown`, async () => {
    const root = testTempDir("opencode-doctor");
    const adapter = createOpencodeAdapter({ command: executable(root, mode) });
    const result = await liveProbe(adapter, runtimes(undefined, undefined), "reviewer");
    assert.equal(result.ok, false);
    assert.match(result.detail, mode === "foreign" ? /forbidden capability/ : /provider/);
  });
}

for (const kind of ["tracked", "untracked", "ignored"]) {
  test(`doctor rejects ${kind} secrets before live opencode calls`, () => {
    const repo = makeRepo();
    try {
      const fixtures = testTempDir("opencode-doctor-secret");
      const command = executable(fixtures, "provider");
      if (kind === "ignored") writeFileSync(path.join(repo.root, ".gitignore"), ".env\n");
      writeFileSync(path.join(repo.root, ".env"), "PRIVATE_SENTINEL");
      if (kind === "tracked") git(repo.root, ["add", ".env"]);
      assert.equal(opencodeSourcePrivacyProbe(repo.root).ok, false);
      const config = path.join(fixtures, "runtimes.json");
      writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          roles: runtimes(undefined, undefined).roles,
          adapters: { opencode: { command } },
        }),
      );
      const result = spawnSync(process.execPath, [BIN, "doctor", "--live", "--json", "--runtimes", config], {
        cwd: repo.root,
        encoding: "utf8",
      });
      const rows = JSON.parse(result.stdout);
      assert.equal(result.status, 20, result.stderr);
      assert.ok(rows.some((row) => /opencode source privacy/.test(row.name) && !row.ok));
      assert.ok(
        rows.some(
          (row) =>
            /experimental opencode warning/.test(row.name) &&
            /public\/synthetic/.test(row.detail) &&
            /third-party/.test(row.detail) &&
            /not privacy certification/.test(row.detail),
        ),
      );
      assert.equal(
        rows.some((row) => /lock-down/.test(row.name)),
        false,
      );
      assert.equal(result.stdout.includes("PRIVATE_SENTINEL"), false);
      const calls = readFileSync(path.join(fixtures, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(calls.every((args) => args.includes("--version")));
    } finally {
      repo.cleanup();
    }
  });
}

for (const required of [false, true]) {
  test(`doctor unknown actual vendor independence is not established (required=${required})`, () => {
    const repo = makeRepo({
      config: {
        version: 1,
        checks: {},
        review: { require_independent: required },
        sandbox: { mode: "none" },
      },
    });
    try {
      const fixtures = testTempDir("opencode-doctor-vendor");
      const config = path.join(fixtures, "runtimes.json");
      writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          roles: {
            implementer: { adapter: "opencode", model: "opencode/free" },
            reviewer: { adapter: "fake" },
          },
          adapters: { opencode: { command: executable(fixtures, "provider") } },
        }),
      );
      const result = spawnSync(process.execPath, [BIN, "doctor", "--json", "--runtimes", config], {
        cwd: repo.root,
        encoding: "utf8",
      });
      const row = JSON.parse(result.stdout).find((entry) => entry.name === "review independence");
      assert.equal(row.ok, !required);
      assert.match(row.detail, /unknown\/not established/);
      assert.doesNotMatch(row.detail, /independent review/);
    } finally {
      repo.cleanup();
    }
  });
}
