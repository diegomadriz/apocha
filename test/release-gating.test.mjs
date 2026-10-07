// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));

for (const selection of ["named", "rule"]) {
  test(`CLI gates ${selection} unsandboxed checks before starting`, () => {
    const repo = makeRepo({
      config: {
        version: 1,
        checks: { host: { run: ["node", "-e", "process.exit(0)"], unsandboxed: true } },
        check_selection: [{ paths: ["src/"], checks: ["host"] }],
        sandbox: { mode: "required" },
      },
    });
    try {
      const script = path.join(repo.root, ".git/fake.mjs");
      writeFileSync(
        script,
        `export default {
        async implementer({ call, bundle }) {
          if (bundle.checks.length) throw new Error("unsandboxed check listed");
          try {
            await call("run_check", { check_id: "host" });
            throw new Error("unsandboxed check ran");
          } catch (error) {
            if (!/unsandboxed.*controller/.test(error.message)) throw error;
          }
          await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
          await call("submit_result", { summary: "Set value" });
        },
        async reviewer({ call, bundle }) {
          await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
        }
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
      const manifest = valueTask({ checks: ["host"] });
      if (selection === "rule") delete manifest.checks;
      writeFileSync(task, JSON.stringify(manifest));
      const args = [
        BIN,
        "run",
        task,
        "--base",
        "main",
        "--batch",
        "gate",
        "--message",
        "Set value",
        "--runtimes",
        runtimes,
        "--json",
      ];
      const run = (extra = []) =>
        spawnSync(process.execPath, [...args, ...extra], {
          cwd: repo.root,
          encoding: "utf8",
        });
      const refused = run();
      assert.equal(refused.status, 2, refused.stdout + refused.stderr);
      assert.match(refused.stderr + refused.stdout, /host.*--allow-governance-edits/);
      assert.equal(run(["--allow-governance-edits", "--reason", " "]).status, 2);
      const approved = run(["--allow-governance-edits", "--reason", "Approve host check"]);
      assert.equal(approved.status, 0, approved.stdout + approved.stderr);
      assert.equal(JSON.parse(approved.stdout).outcome, "PASSED");
    } finally {
      repo.cleanup();
    }
  });
}

test("fixer and tests.run_files receive ./ for option-looking filenames", async () => {
  const file = "-x.test.mjs";
  const source =
    'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("src/value.txt", "utf8").trim(), "2");\n';
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { ok: { run: ["node", "./-x.test.mjs"] } },
      fixers: { format: { run: ["node", "formatter.mjs", "{files}"] } },
      default_fixers: ["format"],
      tests: { paths: [file], run_files: { run: ["node", "{files}"] } },
      sandbox: { mode: "none" },
    },
    files: {
      "formatter.mjs": `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const files = process.argv.slice(2);
assert.ok(files.includes("./-x.test.mjs"));
for (const file of files) {
  assert.ok(file.startsWith("./"));
  writeFileSync(file, readFileSync(file, "utf8").trim() + "\\n");
}
`,
    },
  });
  try {
    const fake = createFakeAdapter({
      handlers: {
        async implementer({ call }) {
          await call("apply_patch", {
            edits: [
              { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
              { path: file, old_text: "", new_text: source + "\n" },
            ],
          });
          await call("submit_result", { summary: "Add option-looking test" });
        },
        async reviewer(context) {
          assert.equal(context.bundle.tests_on_base[0].result, "fails_on_base");
          await passReviewer(context);
        },
      },
    });
    const result = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "files",
      message: "Test safe file arguments",
      runtimes: fakeRuntimes(),
      task: valueTask({ checks: ["ok"], allowed_paths: ["src/", file], max_repair_attempts: 0 }),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(result.outcome, "PASSED", result.reason ?? "");
    // The controller copied back the formatter's edit only when its argv assertion passed.
    const state = new RunStore(repo.root).read(result.run_id).state;
    assert.equal(state.last_verification.fixers[0].status, "pass");
    assert.ok(state.last_verification.fixers[0].changed.includes(file));
  } finally {
    repo.cleanup();
  }
});
