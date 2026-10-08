// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../src/core/run.mjs";
import { landBranch } from "../src/git/land.mjs";
import { gitText, resolveCommit } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

/** @param {string} root @param {string} batch @param {string} [base] @param {number} [value] */
async function passingBatch(root, batch, base = "main", value = 2) {
  const fake = createFakeAdapter({
    handlers: { implementer: writeValue(value), reviewer: passReviewer },
  });
  const result = await startRun({
    cwd: root,
    base,
    batch,
    message: `Set value to ${value}`,
    task: valueTask({ checks: ["ok"] }),
    runtimes: fakeRuntimes(),
    adapters: { implementer: fake, reviewer: fake },
  });
  assert.equal(result.outcome, "PASSED", result.reason ?? "");
  return result;
}

/** @param {string} root @param {string} source */
function land(root, source) {
  return landBranch({ repositoryRoot: root, notesRef: "refs/notes/apocha", source, target: "main" });
}

test("landing a controller batch runs no hooks and updates the checked-out main cleanly", async () => {
  const repo = makeRepo();
  try {
    const run = await passingBatch(repo.root, "A");
    const hooks = ["post-merge", "post-checkout", "reference-transaction"];
    for (const hook of hooks) {
      writeFileSync(
        path.join(repo.root, ".git/hooks", hook),
        `#!/bin/sh\necho ran > "${path.join(repo.root, ".git", `${hook}.marker`)}"\n`,
        { mode: 0o755 },
      );
    }
    const result = land(repo.root, "apocha/batch/A");
    for (const hook of hooks) {
      assert.equal(existsSync(path.join(repo.root, ".git", `${hook}.marker`)), false, hook);
    }
    assert.equal(result.new_head, run.promoted_head);
    assert.equal(resolveCommit(repo.root, "main"), run.promoted_head);
    assert.equal(gitText(repo.root, ["rev-parse", "HEAD"]), run.promoted_head);
    assert.equal(readFileSync(path.join(repo.root, "src/value.txt"), "utf8"), "2\n");
    assert.equal(gitText(repo.root, ["status", "--porcelain"]), "");
  } finally {
    repo.cleanup();
  }
});

test("landing stacked controller batches retires and records both batch refs", async () => {
  const repo = makeRepo();
  try {
    const a = await passingBatch(repo.root, "A");
    const b = await passingBatch(repo.root, "B", "apocha/batch/A", 3);
    const result = land(repo.root, "apocha/batch/B");
    const expected = [
      { ref: "refs/heads/apocha/batch/A", oid: a.promoted_head },
      { ref: "refs/heads/apocha/batch/B", oid: b.promoted_head },
    ];
    assert.equal(resolveCommit(repo.root, "apocha/batch/A"), null);
    assert.equal(resolveCommit(repo.root, "apocha/batch/B"), null);
    assert.equal(resolveCommit(repo.root, "main"), b.promoted_head);
    assert.deepEqual(
      result.retired.toSorted((a, b) => a.ref.localeCompare(b.ref)),
      expected,
    );
    assert.deepEqual(JSON.parse(readFileSync(result.record, "utf8")).retired, result.retired);
    assert.deepEqual(result.kept, []);
    assert.equal(readFileSync(path.join(repo.root, "src/value.txt"), "utf8"), "3\n");
    assert.equal(gitText(repo.root, ["status", "--porcelain"]), "");
  } finally {
    repo.cleanup();
  }
});

test("land restores the target ref when the worktree index update fails", async () => {
  const repo = makeRepo();
  try {
    const oldHead = resolveCommit(repo.root, "main");
    const run = await passingBatch(repo.root, "A");
    const lock = path.join(repo.root, ".git/index.lock");
    writeFileSync(lock, "");
    assert.throws(() => land(repo.root, "apocha/batch/A"), /index.lock/);
    assert.equal(resolveCommit(repo.root, "main"), oldHead);
    assert.equal(resolveCommit(repo.root, "apocha/batch/A"), run.promoted_head);
    rmSync(lock);
    assert.equal(readFileSync(path.join(repo.root, "src/value.txt"), "utf8"), "1\n");
    assert.equal(gitText(repo.root, ["status", "--porcelain"]), "");
  } finally {
    repo.cleanup();
  }
});
