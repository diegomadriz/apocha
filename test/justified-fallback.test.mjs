// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { initProject } from "../src/cli/init.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const testPath = "test/value.test.mjs";
const original = 'import assert from "node:assert/strict";\nassert.equal(2, 2);\n';
const rewritten = original.replace("assert.equal(2, 2)", "assert.ok(true)");
const reason = "justified needs tests.run_files to gather evidence; enforcing additive";
const runFiles = { run: ["node", "--test", "{files}"], cwd: ".", timeout_ms: 300000, dependencies: "npm" };

for (const scenario of ["tool", "direct", "deleted", "addition", "configured"]) {
  test(`default justified policy without evidence: ${scenario}`, async () => {
    const configured = scenario === "configured";
    const repo = makeRepo({
      config: {
        version: 1,
        checks: { tests: { run: ["node", "--test"] } },
        tests: { paths: ["test/"], ...(configured ? { run_files: { run: runFiles.run } } : {}) },
        sandbox: { mode: "none" },
      },
      files: { [testPath]: original, "test/sentinel.test.mjs": "export {};\n" },
    });
    try {
      const fake = createFakeAdapter({
        handlers: {
          implementer: async ({ call, root }) => {
            const patch = { edits: [{ path: testPath, old_text: original, new_text: rewritten }] };
            if (scenario === "tool") {
              await assert.rejects(
                call("apply_patch", patch),
                /test edit policy 'additive'.*Only added lines and added import names/,
              );
              await assert.rejects(
                call("apply_patch", { edits: [{ path: testPath, delete: true }] }),
                /test edit policy 'additive'/,
              );
              assert.equal(readFileSync(path.join(root, testPath), "utf8"), original);
              await call("apply_patch", {
                edits: [{ path: "test/new.test.mjs", old_text: "", new_text: original }],
              });
            } else if (scenario === "direct") writeFileSync(path.join(root, testPath), rewritten);
            else if (scenario === "deleted") unlinkSync(path.join(root, testPath));
            else if (scenario === "addition")
              await call("apply_patch", {
                edits: [{ path: testPath, old_text: original, new_text: original + "assert.equal(3, 3);\n" }],
              });
            else await call("apply_patch", patch);
            await call("submit_result", { summary: scenario });
          },
          reviewer: async (context) => {
            assert.ok(scenario === "tool" || scenario === "addition", "invalid edits must not reach review");
            await passReviewer(context);
          },
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "fallback",
        message: scenario,
        runtimes: fakeRuntimes(),
        task: valueTask({ allowed_paths: ["test/"], checks: ["tests"], max_repair_attempts: 0 }),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(
        summary.outcome,
        scenario === "tool" || scenario === "addition" ? "PASSED" : configured ? "ESCALATED" : "FAILED",
        summary.reason ?? "",
      );
      const store = new RunStore(repo.root);
      assert.equal(store.read(summary.run_id).task.test_edits, "justified");
      const verification = store.read(summary.run_id).state.last_verification;
      const structural = verification.checks.find((entry) => entry.id === "test-edits");
      assert.equal(structural.effective_policy, configured ? "justified" : "additive");
      assert.equal(verification.effective_policy, structural.effective_policy);
      const saved = JSON.parse(
        readFileSync(path.join(store.dir(summary.run_id), "verification-01.json"), "utf8"),
      );
      assert.equal(saved.effective_policy, structural.effective_policy);
      if (configured) {
        assert.equal("reason" in structural, false);
        assert.equal(verification.test_changes[0].verdict, "unnecessary");
        assert.equal(verification.checks.find((entry) => entry.id === "test-changes").status, "fail");
      } else {
        assert.equal(structural.reason, reason);
        assert.equal(saved.reason, reason);
        assert.equal(structural.status, scenario === "direct" || scenario === "deleted" ? "fail" : "pass");
        assert.deepEqual(structural.files, scenario === "direct" || scenario === "deleted" ? [testPath] : []);
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("doctor warns only when run_files is missing", () => {
  for (const configured of [false, true]) {
    const repo = makeRepo({
      config: {
        version: 1,
        checks: { ok: { run: ["node", "--version"] } },
        ...(configured ? { tests: { run_files: { run: runFiles.run } } } : {}),
        sandbox: { mode: "none" },
      },
    });
    try {
      const runtimes = path.join(repo.root, "runtimes.json");
      writeFileSync(
        runtimes,
        JSON.stringify({
          version: 1,
          roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)),
          "doctor",
          "--json",
          "--runtimes",
          runtimes,
        ],
        { cwd: repo.root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const row = JSON.parse(result.stdout).find((entry) => entry.name === "test edit policy");
      if (configured) assert.equal(row, undefined);
      else {
        assert.equal(row.ok, true);
        assert.match(
          row.detail,
          /warning:.*existing-test changes.*limited to additions.*default justified.*tests.run_files.*example:/,
        );
        assert.equal(row.detail.includes("\n"), false);
      }
    } finally {
      repo.cleanup();
    }
  }
});

test("init supplies node --test run_files with the npm dependency contract", () => {
  const repo = makeRepo({
    files: {
      "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.mjs" } }),
      "package-lock.json": "{}",
    },
  });
  try {
    initProject(repo.root, { force: true });
    const config = JSON.parse(readFileSync(path.join(repo.root, "apocha.config.json"), "utf8"));
    assert.deepEqual(config.tests.run_files, runFiles);
  } finally {
    repo.cleanup();
  }
});
