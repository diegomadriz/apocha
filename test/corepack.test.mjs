// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { makeRepo, testCandidate, testTempDir } from "./helpers.mjs";

const keys = ["COREPACK_HOME", "COREPACK_ENABLE_NETWORK", "COREPACK_ENABLE_DOWNLOAD_PROMPT"];
const disabled = { COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/** @param {import("node:test").TestContext} t @param {Record<string, string | undefined>} values */
function hostEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (/** @type {Record<string, string | undefined>} */ env) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

function fixture() {
  const raw = {
    version: 1,
    checks: {
      probe: {
        run: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync('env.json', JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))))`,
        ],
        dependencies: "pnpm",
      },
    },
    sandbox: { mode: "none" },
  };
  const repo = makeRepo({
    config: raw,
    files: {
      ".gitignore": "node_modules/\n",
      "package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
    },
  });
  mkdirSync(path.join(repo.root, "node_modules"));
  return {
    candidate: testCandidate(repo.root, "main"),
    config: normalizeProjectConfig(raw, repo.root),
  };
}

/** @param {ReturnType<typeof fixture>} f @param {"pnpm" | "npm" | "none"} dependencies @param {Record<string, string>} [env] */
async function observe(f, dependencies, env = {}) {
  let captured = null;
  const result = await runCheck({
    ...f,
    check: { ...f.config.checks.probe, dependencies, env },
    backend: "none",
    onFinished: (root) => {
      captured = JSON.parse(readFileSync(path.join(root, "env.json"), "utf8"));
    },
  });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  assert.notEqual(captured, null);
  return captured;
}

for (const dependencies of /** @type {const} */ (["pnpm", "npm"])) {
  for (const source of ["COREPACK_HOME", "XDG_CACHE_HOME", "HOME"]) {
    test(`${dependencies} uses the existing host Corepack cache via ${source}`, async (t) => {
      const f = fixture();
      const host = testTempDir("corepack");
      const cache =
        source === "COREPACK_HOME"
          ? path.join(host, "explicit")
          : path.join(host, ...(source === "HOME" ? [".cache"] : []), "node", "corepack");
      mkdirSync(cache, { recursive: true });
      hostEnv(t, {
        COREPACK_HOME: source === "COREPACK_HOME" ? cache : undefined,
        XDG_CACHE_HOME: source === "XDG_CACHE_HOME" ? host : undefined,
        HOME: host,
        COREPACK_ENABLE_NETWORK: "1",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
      });
      assert.equal(os.homedir(), host);
      assert.deepEqual(await observe(f, dependencies), { COREPACK_HOME: cache, ...disabled });
    });
  }

  test(`${dependencies} disables downloads even when the host cache is missing`, async (t) => {
    const f = fixture();
    const host = testTempDir("corepack");
    // An explicit missing cache must not fall back to an existing XDG cache.
    mkdirSync(path.join(host, "node", "corepack"), { recursive: true });
    hostEnv(t, { COREPACK_HOME: path.join(host, "missing"), XDG_CACHE_HOME: host });
    assert.deepEqual(await observe(f, dependencies), disabled);
  });

  test(`${dependencies} lets check.env override Corepack defaults`, async (t) => {
    const f = fixture();
    const cache = testTempDir("corepack");
    hostEnv(t, { COREPACK_HOME: cache });
    assert.deepEqual(await observe(f, dependencies), { COREPACK_HOME: cache, ...disabled });
    const overrides = {
      COREPACK_HOME: path.join(cache, "override"),
      COREPACK_ENABLE_NETWORK: "1",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
    };
    assert.deepEqual(await observe(f, dependencies, overrides), overrides);
  });
}

test("none dependencies do not inherit Corepack settings after a pnpm check", async (t) => {
  const f = fixture();
  const cache = testTempDir("corepack");
  hostEnv(t, {
    COREPACK_HOME: cache,
    COREPACK_ENABLE_NETWORK: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
  });
  assert.deepEqual(await observe(f, "pnpm"), { COREPACK_HOME: cache, ...disabled });
  assert.deepEqual(await observe(f, "none"), {});
});
