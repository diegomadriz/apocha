// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { detectBackend, SANDBOX_MARKER } from "../src/sandbox/index.mjs";
import { makeRepo, testCandidate } from "./helpers.mjs";

test("an inherited legacy sandbox marker prevents nested sandbox detection", () => {
  const current = process.env[SANDBOX_MARKER];
  const legacy = process.env.PANAGENT_SANDBOX;
  try {
    delete process.env[SANDBOX_MARKER];
    process.env.PANAGENT_SANDBOX = "seatbelt";
    assert.equal(detectBackend(), null);
  } finally {
    if (current === undefined) delete process.env[SANDBOX_MARKER];
    else process.env[SANDBOX_MARKER] = current;
    if (legacy === undefined) delete process.env.PANAGENT_SANDBOX;
    else process.env.PANAGENT_SANDBOX = legacy;
  }
});

test("a real sandboxed check receives both current and legacy markers", async (t) => {
  const backend = detectBackend();
  if (!backend) {
    t.skip("no sandbox backend available (including inside an inherited sandbox)");
    return;
  }
  const repo = makeRepo({
    files: {
      "markers.mjs": "console.log(process.env.APOCHA_SANDBOX); console.log(process.env.PANAGENT_SANDBOX);\n",
    },
  });
  const candidate = testCandidate(repo.root, "main");
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: { markers: { run: ["node", "markers.mjs"] } },
      sandbox: { mode: "required" },
    },
    repo.root,
  );
  try {
    const result = await runCheck({ check: config.checks.markers, candidate, config, backend });
    assert.equal(result.status, "pass", result.stderr);
    assert.equal(result.stdout, `${backend}\n${backend}\n`);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});
