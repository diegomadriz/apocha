// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDefinitionDigest, runCheck } from "../src/checks/runner.mjs";
import { loadProjectConfig, normalizeProjectConfig, selectChecks } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { detectBackend } from "../src/sandbox/index.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testCandidate,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));
const markerProbe =
  "console.log(JSON.stringify([process.env.APOCHA_SANDBOX ?? null, process.env.PANAGENT_SANDBOX ?? null]));";

test("runCheck overrides a sandbox backend and removes catalog markers under required mode", async () => {
  const repo = makeRepo();
  const candidate = testCandidate(repo.root, "main");
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: {
        probe: {
          run: ["node", "-e", markerProbe],
          unsandboxed: true,
          env: { APOCHA_SANDBOX: "catalog", PANAGENT_SANDBOX: "catalog" },
        },
        normal: { run: ["node", "-e", markerProbe] },
      },
      sandbox: { mode: "required" },
    },
    repo.root,
  );
  const result = await runCheck({ candidate, config, check: config.checks.probe, backend: "seatbelt" });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  assert.equal(result.sandbox, "none");
  assert.deepEqual(JSON.parse(result.stdout), [null, null]);
  assert.equal(config.checks.normal.unsandboxed, false);
  assert.notEqual(
    checkDefinitionDigest(config.checks.probe),
    checkDefinitionDigest({ ...config.checks.probe, unsandboxed: false }),
  );
});

test("controller warns and receipts an unsandboxed check alongside a normal sandboxed check when available", async () => {
  const backend = detectBackend();
  const checks = {
    selftest: {
      run: [
        "node",
        "-e",
        `const assert = require('node:assert/strict'); assert.equal(process.env.APOCHA_SANDBOX, undefined); assert.equal(process.env.PANAGENT_SANDBOX, undefined);`,
      ],
      unsandboxed: true,
    },
    ...(backend
      ? {
          normal: {
            run: [
              "node",
              "-e",
              `const assert = require('node:assert/strict'); assert.equal(process.env.APOCHA_SANDBOX, '${backend}'); assert.equal(process.env.PANAGENT_SANDBOX, '${backend}');`,
            ],
          },
        }
      : {}),
  };
  const repo = makeRepo({ config: { version: 1, checks, sandbox: { mode: "required" } } });
  const fake = createFakeAdapter({
    handlers: {
      async implementer(context) {
        assert.equal(
          context.bundle.checks.some((check) => check.id === "selftest"),
          false,
        );
        await assert.rejects(context.call("run_check", { check_id: "selftest" }), /unsandboxed.*controller/);
        await writeValue(2)(context);
      },
      reviewer: passReviewer,
    },
  });
  // Repeat to prove the warning is emitted on every run, not just once per project.
  for (const batch of ["first", "second"]) {
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch,
      message: `Set value ${batch}`,
      allowGovernanceEdits: true,
      governanceReason: "Approve self-test",
      runtimes: fakeRuntimes(),
      task: valueTask({ checks: Object.keys(checks) }),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const events = new RunStore(repo.root).events(summary.run_id);
    const warning = events.find((event) => event.type === "sandbox.warning" && event.check_id === "selftest");
    assert.match(warning?.message ?? "", /selftest.*without an OS sandbox/);
    const receipt = verifyReceipt(
      repo.root,
      "refs/notes/apocha",
      /** @type {string} */ (summary.promoted_head),
    );
    assert.equal(receipt.valid, true, receipt.reason ?? "");
    assert.equal(receipt.receipt.checks.find((check) => check.id === "selftest").sandbox, "none");
    assert.equal(
      events.find((event) => event.type === "check.finished" && event.id === "selftest").sandbox,
      "none",
    );
    if (backend) {
      assert.equal(receipt.receipt.checks.find((check) => check.id === "normal").sandbox, backend);
    }
  }
});

test("CLI warns in quiet mode and doctor lists explicitly unsandboxed checks without a backend", () => {
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { selftest: { run: ["node", "-e", markerProbe], unsandboxed: true } },
      default_checks: ["selftest"],
      sandbox: { mode: "required" },
    },
  });
  const script = path.join(repo.root, ".git/fake.mjs");
  writeFileSync(
    script,
    `export default {
    async implementer({ bundle, call }) {
      await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
      await call("submit_result", { summary: "set value", criteria_evidence: bundle.acceptance_criteria.map((_, index) => ({ criterion: index + 1, evidence: [{ kind: "check", check_id: "selftest" }] })) });
    },
    async reviewer({ bundle, call }) {
      await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
    },
  };`,
  );
  const runtimes = path.join(repo.root, ".git/runtimes.json");
  writeFileSync(
    runtimes,
    JSON.stringify({
      version: 1,
      roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
      adapters: { fake: { script } },
    }),
  );
  const task = path.join(repo.root, ".git/task.json");
  writeFileSync(task, JSON.stringify(valueTask({ checks: ["selftest"] })));
  const env = { ...process.env, APOCHA_SANDBOX: "inherited", PANAGENT_SANDBOX: "inherited" };
  const run = spawnSync(
    process.execPath,
    [
      BIN,
      "run",
      task,
      "--base",
      "main",
      "--batch",
      "cli",
      "--message",
      "Set value",
      "--runtimes",
      runtimes,
      "--json",
      "--quiet",
      "--allow-governance-edits",
      "--reason",
      "Approve self-test",
    ],
    { cwd: repo.root, encoding: "utf8", env },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).outcome, "PASSED");
  assert.match(run.stderr, /warning: check selftest will execute without an OS sandbox/);
  const doctor = spawnSync(process.execPath, [BIN, "doctor", "--runtimes", runtimes, "--json"], {
    cwd: repo.root,
    encoding: "utf8",
    env,
  });
  assert.match(doctor.stdout, /"name": "unsandboxed checks"/);
  assert.match(doctor.stdout, /"detail": "selftest"/);
});

test("Apocha config governs every selection path for unsandboxed checks", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const config = loadProjectConfig(root);
  for (const rule of config.check_selection) {
    if (!rule.checks.some((id) => config.checks[id].unsandboxed)) continue;
    for (const selectedPath of rule.paths) {
      assert.ok(
        config.paths.governance.some(
          (entry) => selectedPath === entry || (entry.endsWith("/") && selectedPath.startsWith(entry)),
        ),
        `Unsandboxed check selection path must be governed: ${selectedPath}`,
      );
    }
  }
});

test("loaded Apocha config selects sandbox-selftest only for sandbox, check runner, and real sandbox tests", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const config = loadProjectConfig(root);
  const check = config.checks["sandbox-selftest"];
  assert.ok(check);
  assert.equal(check.unsandboxed, true);
  assert.equal(check.dependencies, "npm");
  assert.equal(check.cwd, ".");
  assert.equal(check.timeout_ms, 300000);
  const files = [
    "test/sandbox.test.mjs",
    "test/sandbox-defaults.test.mjs",
    "test/sandbox-strict.test.mjs",
    "test/sandbox-markers.test.mjs",
    "test/source-secrets.test.mjs",
  ];
  assert.deepEqual(check.run, ["node", "--test", ...files]);
  for (const changed of ["src/sandbox/index.mjs", "src/checks/runner.mjs", ...files]) {
    assert.ok(selectChecks(config, [changed]).includes("sandbox-selftest"), changed);
  }
  for (const changed of ["README.md", "src/cli/main.mjs", "test/config-workflow.test.mjs"]) {
    assert.equal(selectChecks(config, [changed]).includes("sandbox-selftest"), false, changed);
  }
  assert.equal(config.default_checks.includes("sandbox-selftest"), false);
});
