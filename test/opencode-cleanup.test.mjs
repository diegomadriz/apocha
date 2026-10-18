// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpencodeAdapter } from "../src/adapters/opencode/index.mjs";
import { HarnessError } from "../src/util/errors.mjs";

/** Fake CLI only; node --test isolates this file's builtin patch from other suites.
 * @param {string} behavior
 * @param {boolean} failCleanup
 * @param {(adapter: ReturnType<typeof createOpencodeAdapter>, invocation: import("../src/adapters/contract.mjs").Invocation, roots: string[]) => Promise<void>} verify
 */
async function scenario(behavior, failCleanup, verify) {
  const originalRm = fs.rmSync;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "apocha-cleanup-test-"));
  /** @type {string[]} */
  const roots = [];
  try {
    const repo = path.join(fixture, "repo");
    fs.mkdirSync(repo);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    const sessionFile = path.join(fixture, "session.json");
    fs.writeFileSync(sessionFile, JSON.stringify({ repository_root: repo }));
    const command = path.join(fixture, "opencode");
    fs.writeFileSync(
      command,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        'const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));',
        'const phase = process.argv.includes("--version") ? "version" : process.argv.includes("debug") ? "config" : "run";',
        behavior,
        'if (phase === "version") console.log("1.19.3");',
        'else if (phase === "config") console.log(JSON.stringify(config));',
        'else { process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({type:"text",part:{text:"complete"}}))); }',
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.rmSync = (target, options) => {
      if (typeof target === "string" && path.basename(target).startsWith("apocha-opencode-")) {
        roots.push(target);
        if (failCleanup) throw new Error("synthetic secret-token filesystem failure at " + target);
      }
      return originalRm(target, options);
    };
    syncBuiltinESMExports();
    await verify(
      createOpencodeAdapter({ command }),
      {
        role: "implementer",
        model: "opencode/synthetic-free",
        provider: "synthetic-vendor",
        systemPrompt: "synthetic system",
        taskPrompt: "synthetic task",
        bundle: {},
        sessionDir: fixture,
        sessionFile,
        cwd: repo,
        timeoutMs: 5000,
      },
      roots,
    );
    assert.equal(roots.length, 1, "cleanup attempted exactly once for the allocated root");
    assert.equal(fs.existsSync(roots[0]), failCleanup);
  } finally {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
    for (const root of roots) originalRm(root, { recursive: true, force: true });
    originalRm(fixture, { recursive: true, force: true });
  }
}

/** @param {unknown} error */
function safeError(error) {
  assert.ok(error instanceof HarnessError);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(
    JSON.stringify(error) + error.message + error.stack,
    /secret-token|synthetic secret|apocha-opencode-/,
  );
  return error;
}

test("usage limit survives cleanup failure with retry time and runtime details", async () => {
  await scenario(
    'if (phase === "run") { console.log(JSON.stringify({type:"error",error:{data:{message:"usage limit; try again at 12:30 UTC"}}})); process.exit(1); }',
    true,
    async (adapter, invocation) => {
      await assert.rejects(adapter.run(invocation), (error) => {
        const failure = safeError(error);
        assert.equal(failure.errorClass, "usage_limited");
        assert.equal(failure.code, "opencode_provider_error");
        assert.equal(failure.retryAfter, "12:30 UTC");
        assert.equal(failure.message, "OpenCode provider rejected the request");
        assert.deepEqual(failure.details, {
          runtime: {
            adapter: "opencode",
            adapter_version: "1.19.3",
            model: invocation.model,
            provider: invocation.provider,
          },
          cleanup_failed: true,
        });
        return true;
      });
    },
  );
});

test("foreign tool policy failure survives cleanup failure without retry metadata", async () => {
  await scenario(
    'if (phase === "run") { console.log(JSON.stringify({type:"tool",tool:"bash"})); process.exit(0); }',
    true,
    async (adapter, invocation) => {
      await assert.rejects(adapter.run(invocation), (error) => {
        const failure = safeError(error);
        assert.equal(failure.errorClass, "policy_violation");
        assert.equal(failure.code, "opencode_foreign_tool");
        assert.equal(failure.retryAfter, null);
        assert.deepEqual(failure.details, { cleanup_failed: true });
        return true;
      });
    },
  );
});

test("successful invocation with failed cleanup reports sanitized infra", async () => {
  await scenario("", true, async (adapter, invocation) => {
    await assert.rejects(adapter.run(invocation), (error) => {
      const failure = safeError(error);
      assert.equal(failure.errorClass, "infra");
      assert.equal(failure.code, "opencode_cleanup");
      assert.equal(failure.message, "OpenCode private runtime cleanup failed");
      assert.equal(failure.retryAfter, null);
      assert.deepEqual(failure.details, {});
      return true;
    });
  });
});

test("successful invocation removes its private root", async () => {
  await scenario("", false, async (adapter, invocation) => {
    assert.equal((await adapter.run(invocation)).final_message, "complete");
  });
});

test("successful probe with failed cleanup reports failure", async () => {
  await scenario("", true, async (adapter) => {
    const probe = await adapter.probe();
    assert.equal(probe.ok, false);
    assert.deepEqual(probe.problems, ["OpenCode private runtime cleanup failed"]);
  });
});

test("version and config failures retain safe details when cleanup fails", async () => {
  for (const phase of ["version", "config"]) {
    await scenario(
      phase === "version"
        ? 'if (phase === "version") { console.log("1.19.2"); process.exit(0); }'
        : 'if (phase === "config") { console.log("{}"); process.exit(0); }',
      true,
      async (adapter, invocation) => {
        await assert.rejects(adapter.run(invocation), (error) => {
          const failure = safeError(error);
          assert.equal(failure.errorClass, "config");
          assert.equal(
            failure.code,
            phase === "version" ? "opencode_version" : "opencode_config_contamination",
          );
          assert.deepEqual(
            failure.details,
            phase === "version" ? { version: "1.19.2", cleanup_failed: true } : { cleanup_failed: true },
          );
          return true;
        });
      },
    );
  }
});

test("timed out invocation still attempts cleanup once and preserves timeout", async () => {
  await scenario("", true, async (adapter, invocation) => {
    await assert.rejects(adapter.run({ ...invocation, timeoutMs: 1 }), (error) => {
      const failure = safeError(error);
      assert.equal(failure.errorClass, "infra");
      assert.equal(failure.code, "timeout");
      assert.deepEqual(failure.details, { cleanup_failed: true });
      return true;
    });
  });
});

test("aborted invocation still attempts cleanup once and preserves abort", async () => {
  await scenario("", true, async (adapter, invocation) => {
    await assert.rejects(adapter.run({ ...invocation, signal: AbortSignal.abort() }), (error) => {
      const failure = safeError(error);
      assert.equal(failure.errorClass, "infra");
      assert.equal(failure.code, "aborted");
      assert.deepEqual(failure.details, { cleanup_failed: true });
      return true;
    });
  });
});
