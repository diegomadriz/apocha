// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { initialState } from "../src/core/context.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { runPromoteStage } from "../src/stages/promote.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testCandidate,
  valueTask,
} from "./helpers.mjs";

const enabled = '{"linter":{"enabled":true}}\n';
const disabled = '{"linter":{"enabled":false}}\n';
const declaration = { path: "src/biome.json", kind: "fix", reason: "Update linter configuration." };
const lintSource = `
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) { walk(file); continue; }
    if (name === "biome.json" || !readFileSync(file, "utf8").includes("TODO")) continue;
    let current = path.dirname(file);
    let enabled = true;
    while (true) {
      const config = path.join(current, "biome.json");
      if (existsSync(config)) { enabled = JSON.parse(readFileSync(config, "utf8")).linter?.enabled !== false; break; }
      const parent = path.dirname(current);
      if (current === "." || parent === current) break;
      current = parent;
    }
    if (enabled) { console.error("TODO in " + file); process.exitCode = 1; }
  }
}
walk("src");
`;

function fixture(existing = false) {
  return makeRepo({
    config: {
      version: 1,
      checks: { lint: { run: ["node", "lint.mjs"] }, test: { run: ["node", "check.mjs"] } },
      default_checks: ["lint", "test"],
      sandbox: { mode: "none" },
    },
    files: { "lint.mjs": lintSource, ...(existing ? { "src/biome.json": enabled } : {}) },
  });
}

/** @param {"loosen" | "harmless" | "none"} mode */
async function runChange(mode) {
  const repo = fixture(mode === "harmless");
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call }) => {
        await call("read_files", { paths: ["src/value.txt", "src/biome.json", "src/note.txt"] });
        await call("apply_patch", {
          edits: [
            { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
            ...(mode === "none"
              ? []
              : [
                  {
                    path: declaration.path,
                    old_text: mode === "harmless" ? enabled : "",
                    new_text:
                      mode === "harmless" ? '{"linter":{"enabled":true},"harmless":true}\n' : disabled,
                  },
                ]),
            ...(mode === "loosen" ? [{ path: "src/note.txt", old_text: "", new_text: "TODO\n" }] : []),
          ],
        });
        await call("submit_result", {
          summary: "Update fixture",
          ...(mode === "none" ? {} : { judge_input_changes: [declaration] }),
        });
      },
      reviewer: passReviewer,
    },
  });
  const summary = await startRun({
    cwd: repo.root,
    base: "main",
    batch: "set-value",
    message: "Update fixture",
    runtimes: fakeRuntimes(),
    task: valueTask({ checks: ["lint", "test"] }),
    adapters: { implementer: fake, reviewer: fake },
  });
  return { repo, summary, store: new RunStore(repo.root) };
}

/** @param {Awaited<ReturnType<typeof runChange>>} result */
function assertLoosened({ repo, summary, store }) {
  assert.equal(summary.outcome, "ESCALATED", summary.reason ?? "");
  assert.equal(
    summary.reason,
    "declared judge input changes are needed for checks to pass: lint fail with the base versions of src/biome.json",
  );
  assert.equal(summary.promoted_head, null);
  assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/set-value"), null);
  assert.equal(resolveCommit(repo.root, "refs/notes/apocha"), null);
  const verification = store.read(summary.run_id).state.last_verification;
  assert.equal(verification.status, "loosened");
  assert.equal(verification.base_judge.status, "fail");
  assert.deepEqual(verification.base_judge.restored, ["src/biome.json"]);
  assert.equal(verification.base_judge.checks.find((check) => check.id === "lint").status, "fail");
  const events = store.events(summary.run_id);
  const event = events.find((entry) => entry.type === "base-judge.finished");
  assert.equal(event.status, "fail");
  assert.deepEqual(event.failed_checks, ["lint"]);
  assert.equal("stdout" in event || "stderr" in event, false);
  assert.equal(
    events.some((entry) => entry.type === "promotion.finished"),
    false,
  );
  const evidence = JSON.parse(
    readFileSync(
      path.join(
        store.dir(summary.run_id),
        `verification-${String(store.read(summary.run_id).state.attempt).padStart(2, "0")}.json`,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(evidence.base_judge, verification.base_judge);
}

test("declared loosening escalates without repair, promotion or receipt", async () => {
  const result = await runChange("loosen");
  try {
    assertLoosened(result);
  } finally {
    result.repo.cleanup();
  }
});

test("non-loosening declaration passes and receipt verifies with base-judge evidence", async () => {
  const { repo, summary, store } = await runChange("harmless");
  try {
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const verified = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
    assert.equal(verified.valid, true, verified.reason ?? "");
    assert.deepEqual(verified.receipt.judge_inputs, {
      changes: [{ ...declaration, change: "modified", declared_by: "implementer" }],
      verdicts: [{ path: declaration.path, verdict: "justified" }],
      base_judge: { status: "pass", restored: ["src/biome.json"], checks: ["lint", "test"] },
    });
    assert.equal(store.read(summary.run_id).state.last_verification.base_judge.status, "pass");
    for (const mutation of ["status", "restored"]) {
      const receipt = structuredClone(verified.receipt);
      if (mutation === "status") receipt.judge_inputs.base_judge.status = "fail";
      else receipt.judge_inputs.base_judge.restored = ["other/biome.json"];
      git(repo.root, ["notes", "--ref=refs/notes/apocha", "add", "-f", "-F", "-", summary.promoted_head], {
        input: JSON.stringify(receipt),
      });
      const invalid = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
      assert.equal(invalid.valid, false);
      assert.match(
        invalid.reason ?? "",
        mutation === "status" ? /schema/ : /restored path is missing from changes/,
      );
    }
  } finally {
    repo.cleanup();
  }
});

test("without judge input changes no base-judge run or receipt field is added", async () => {
  const { repo, summary, store } = await runChange("none");
  try {
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const receipt = verifyReceipt(repo.root, "refs/notes/apocha", summary.promoted_head);
    assert.equal(receipt.valid, true, receipt.reason ?? "");
    assert.equal("judge_inputs" in receipt.receipt, false);
    assert.equal("base_judge" in store.read(summary.run_id).state.last_verification, false);
    assert.equal(
      store.events(summary.run_id).some((event) => event.type === "base-judge.finished"),
      false,
    );
  } finally {
    repo.cleanup();
  }
});

test("promotion refuses declared changes with failed or missing base-judge evidence", async () => {
  for (const status of ["fail", undefined]) {
    const state = initialState("promote");
    state.last_verification = {
      status: "pass",
      candidate_digest: "a".repeat(64),
      changed_files: [],
      checks: [],
      judge_input_changes: [{ ...declaration, kind: "fix", change: "added", declared_by: "implementer" }],
      ...(status
        ? { base_judge: { status: /** @type {"fail"} */ (status), restored: [declaration.path], checks: [] } }
        : {}),
    };
    const ctx = /** @type {import("../src/core/context.mjs").RunContext} */ (
      /** @type {unknown} */ ({ state })
    );
    await assert.rejects(
      runPromoteStage({ kind: "promote", on: { done: "PASSED" } }, ctx),
      (error) =>
        error instanceof HarnessError &&
        error.errorClass === "integrity" &&
        error.code === "judge_not_verified",
    );
  }
});

test("runCheck baseFiles removes an added file absent from base", async () => {
  const repo = makeRepo();
  try {
    const candidate = testCandidate(repo.root, "main");
    writeFileSync(path.join(candidate.root, "src/biome.json"), disabled);
    const config = normalizeProjectConfig(
      {
        version: 1,
        sandbox: { mode: "none" },
        checks: {
          absent: {
            run: ["node", "-e", "process.exit(require('node:fs').existsSync('src/biome.json') ? 1 : 0)"],
          },
        },
      },
      repo.root,
    );
    const options = {
      candidate,
      config,
      backend: /** @type {const} */ ("none"),
      check: config.checks.absent,
    };
    assert.equal((await runCheck(options)).status, "fail");
    assert.equal((await runCheck({ ...options, baseFiles: ["src/biome.json"] })).status, "pass");
    assert.equal(readFileSync(path.join(candidate.root, "src/biome.json"), "utf8"), disabled);
  } finally {
    repo.cleanup();
  }
});

test("integration loosening is declared by integration and escalates through base-judge", async () => {
  const repo = fixture();
  try {
    git(repo.root, ["checkout", "-qb", "topic"]);
    writeFileSync(path.join(repo.root, "src/value.txt"), "2\n");
    writeFileSync(path.join(repo.root, "src/note.txt"), "TODO\n");
    writeFileSync(path.join(repo.root, "src/biome.json"), disabled);
    git(repo.root, ["add", "-A"]);
    git(repo.root, ["commit", "-qm", "topic loosens lint"]);
    git(repo.root, ["checkout", "-q", "main"]);
    const fake = createFakeAdapter({
      handlers: {
        implementer: async () => {
          assert.fail("loosening must never be repaired");
        },
        reviewer: async () => {
          assert.fail("loosening must never be reviewed");
        },
      },
    });
    const summary = await startRun({
      cwd: repo.root,
      workflow: "integrate",
      base: "main",
      batch: "set-value",
      message: "Integrate topic",
      runtimes: fakeRuntimes(),
      integration: { topic: "topic", checks: ["lint", "test"] },
      adapters: { implementer: fake, reviewer: fake },
    });
    const store = new RunStore(repo.root);
    assertLoosened({ repo, summary, store });
    assert.equal(
      store.read(summary.run_id).state.last_verification.judge_input_changes[0].declared_by,
      "integration",
    );
  } finally {
    repo.cleanup();
  }
});
