// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "../src/util/git.mjs";
import { makeRepo } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/panagent.mjs", import.meta.url));

/** @param {string} cwd @param {string[]} args */
function cli(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("help, version, and unknown commands", () => {
  assert.match(cli(os.tmpdir(), ["--help"]).stdout, /Usage: panagent <command>/);
  assert.match(cli(os.tmpdir(), ["version"]).stdout, /^\d+\.\d+\.\d+/);
  const unknown = cli(os.tmpdir(), ["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
});

test("init writes a starter config that validates, and refuses to overwrite", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "panagent-cli-")));
  git(root, ["init", "-q"]);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", lint: "x" } }),
  );
  const first = cli(root, ["init"]);
  assert.equal(first.code, 0, first.stderr);
  const config = JSON.parse(readFileSync(path.join(root, "panagent.config.json"), "utf8"));
  assert.deepEqual(Object.keys(config.checks).sort(), ["lint", "test"]);
  assert.equal(cli(root, ["init"]).code, 2);
});

test("validate prints the normalized task and rejects bad ones", () => {
  const repo = makeRepo();
  try {
    const file = path.join(repo.root, "task.json");
    writeFileSync(
      file,
      JSON.stringify({
        task_id: "t1",
        description: "d",
        acceptance_criteria: ["c"],
        allowed_paths: ["src/"],
      }),
    );
    const ok = cli(repo.root, ["validate", file]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).checks, ["test"]);
    writeFileSync(
      file,
      JSON.stringify({
        task_id: "t1",
        description: "d",
        acceptance_criteria: ["c"],
        allowed_paths: ["src/"],
        checks: ["rm"],
      }),
    );
    const bad = cli(repo.root, ["validate", file]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown check/);
  } finally {
    repo.cleanup();
  }
});

test("run with a scripted fake runtime passes end to end through the CLI", () => {
  const repo = makeRepo();
  try {
    const script = path.join(repo.root, "..", `fake-${path.basename(repo.root)}.mjs`);
    writeFileSync(
      script,
      `export default {
  async implementer({ call }) {
    await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
    await call("submit_result", { summary: "set to 2" });
  },
  async reviewer({ bundle, call }) {
    await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
  },
};
`,
    );
    const runtimes = path.join(repo.root, "..", `runtimes-${path.basename(repo.root)}.json`);
    writeFileSync(
      runtimes,
      JSON.stringify({
        version: 1,
        roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        adapters: { fake: { script } },
      }),
    );
    const task = path.join(repo.root, "..", `task-${path.basename(repo.root)}.json`);
    writeFileSync(
      task,
      JSON.stringify({
        task_id: "cli-run",
        description: "Set src/value.txt to 2",
        acceptance_criteria: ["value is 2"],
        allowed_paths: ["src/"],
      }),
    );
    const run = cli(repo.root, [
      "run",
      task,
      "--base",
      "main",
      "--batch",
      "cli-run",
      "--message",
      "Set value",
      "--runtimes",
      runtimes,
      "--json",
    ]);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.outcome, "PASSED");
    const receipt = cli(repo.root, ["receipt", summary.promoted_head]);
    assert.equal(receipt.code, 0);
    assert.equal(JSON.parse(receipt.stdout).valid, true);
    const runs = cli(repo.root, ["runs"]);
    assert.match(runs.stdout, /^PASSED\s+cli-run-/m);
    const metrics = cli(repo.root, ["metrics", "--json"]);
    assert.equal(JSON.parse(metrics.stdout).runs.by_outcome.PASSED, 1);
    const land = cli(repo.root, ["land", "panagent/batch/cli-run", "--target", "main"]);
    assert.equal(land.code, 0, land.stderr);
    assert.match(land.stdout, /landed 1 commit/);
  } finally {
    repo.cleanup();
  }
});
