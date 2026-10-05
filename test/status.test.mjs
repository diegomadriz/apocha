// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RunStore, stateDir } from "../src/core/runs.mjs";
import { repositoryStatus } from "../src/core/status.mjs";
import { digestBetweenCommits } from "../src/git/candidate.mjs";
import { commitIdentity, git, gitCommonDir, gitText } from "../src/util/git.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/panagent.mjs", import.meta.url));
const PREFIX = "refs/heads/panagent/batch/";

/** Snapshot file contents recursively, including the Git index and run store. @param {string} root */
function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, readFileSync(file).toString("hex")]];
  });
}

test("status reports batches, attention, records, disk and suggestions without writes", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const temporary = testTempDir("status");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  const base = gitText(repo.root, ["rev-parse", "HEAD"]);
  git(repo.root, ["update-ref", PREFIX + "landed", base]);
  git(repo.root, ["checkout", "-qb", "panagent/batch/ready"]);
  writeFileSync(path.join(repo.root, "src/value.txt"), "2\n");
  git(repo.root, ["commit", "-qam", "ready"]);
  const tip = gitText(repo.root, ["rev-parse", "HEAD"]);
  const identity = commitIdentity(repo.root, tip);
  // A supported legacy receipt exercises real digest and commit validation.
  const receipt = {
    version: 1,
    task_id: "status-task",
    promoted_head: tip,
    tree: identity.tree,
    parents: identity.parents,
    base_commit: base,
    candidate_digest: digestBetweenCommits(repo.root, base, tip),
    checks: [{ status: "pass" }],
    review_decision: "PASS",
    repair_attempts: 0,
    implementer_invocations: 1,
    runtimes: {},
  };
  git(repo.root, ["notes", "--ref=refs/notes/panagent", "add", "-m", JSON.stringify(receipt), tip]);
  const store = new RunStore(repo.root);
  const paused = "paused-20260101T000000Z-0001";
  store.create(paused, { outcome: "PAUSED", state: { awaiting: "approval" } });
  store.create("passed-20260101T000000Z-0002", { outcome: "PASSED", promoted_head: tip });
  store.create("stale-20260101T000000Z-0003", { outcome: "RUNNING", pid: 2147483647 });
  store.create("running-20260101T000000Z-0004", { outcome: "RUNNING", pid: process.pid });
  git(repo.root, ["checkout", "-qb", "panagent/batch/unreceipted"]);
  writeFileSync(path.join(repo.root, "src/value.txt"), "3\n");
  git(repo.root, ["commit", "-qam", "unreceipted"]);
  git(repo.root, ["checkout", "-q", "main"]);
  const diverged = String(
    git(repo.root, ["commit-tree", identity.tree], { input: "diverged\n" }).stdout,
  ).trim();
  git(repo.root, ["update-ref", PREFIX + "diverged", diverged]);
  writeFileSync(path.join(repo.root, "untracked.txt"), "dirty");
  const owned = path.join(temporary, "panagent-owned");
  mkdirSync(owned);
  writeFileSync(
    path.join(owned, ".panagent-owner"),
    JSON.stringify({
      kind: "candidate",
      run_id: null,
      pid: 2147483647,
      created_at: "2020-01-01T00:00:00Z",
      repository: gitCommonDir(repo.root),
    }),
  );
  const directory = stateDir(repo.root);
  for (const kind of ["lands", "gc"]) mkdirSync(path.join(directory, kind));
  writeFileSync(
    path.join(directory, "lands", "record.json"),
    JSON.stringify({
      created_at: "2026-01-01T00:00:00Z",
      commits: [tip],
      retired: [],
      kept: [],
    }),
  );
  writeFileSync(
    path.join(directory, "gc", "record.json"),
    JSON.stringify({
      created_at: "2026-01-02T00:00:00Z",
      done: [{}],
      skipped: [],
      total_size: 10,
    }),
  );
  const before = snapshot(gitCommonDir(repo.root));
  const refs = gitText(repo.root, ["show-ref"]);
  const status = repositoryStatus(repo.root);
  assert.equal(status.target.branch, "main");
  assert.equal(status.target.clean, false);
  assert.equal(status.batches.find((batch) => batch.ref === PREFIX + "landed")?.state, "landed");
  assert.equal(status.batches.find((batch) => batch.ref === PREFIX + "ready")?.state, "ready");
  assert.equal(status.batches.find((batch) => batch.ref === PREFIX + "ready")?.receipted, true);
  assert.equal(status.batches.find((batch) => batch.ref === PREFIX + "unreceipted")?.state, "unreceipted");
  assert.equal(status.batches.find((batch) => batch.ref === PREFIX + "diverged")?.state, "diverged");
  assert.ok(status.runs.attention.some((run) => run.state === "STALE"));
  assert.ok(status.runs.attention.some((run) => run.state === "RUNNING"));
  assert.equal(status.runs.attention.find((run) => run.run_id === paused)?.awaiting, "approval");
  assert.ok(status.suggested_actions.includes(`land ${PREFIX}ready --target main`));
  assert.ok(status.suggested_actions.includes(`resume ${paused}`));
  assert.ok(status.suggested_actions.includes("panagent gc"));
  assert.equal(status.last_land?.commits, 1);
  assert.equal(status.last_gc?.done, 1);
  assert.equal(status.disk.temp.owned.count, 1);
  assert.equal(status.disk.temp.orphan_count, 1);
  assert.ok(status.disk.run_store_size > 0);
  const json = spawnSync(process.execPath, [BIN, "status", "--json"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), status);
  assert.deepEqual(Object.keys(status), [
    "target",
    "batches",
    "runs",
    "graph",
    "last_land",
    "last_gc",
    "disk",
    "suggested_actions",
  ]);
  const human = spawnSync(process.execPath, [BIN, "status"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  for (const section of ["Target", "Batches", "Runs", "Graph", "Last records", "Disk", "Next actions"])
    assert.ok(human.stdout.includes(section));
  assert.deepEqual(snapshot(gitCommonDir(repo.root)), before);
  assert.equal(gitText(repo.root, ["show-ref"]), refs);
  assert.equal(existsSync(path.join(directory, "lock")), false);
  assert.throws(() => repositoryStatus(repo.root, { target: "--bad" }), /branch name/);
  assert.throws(() => repositoryStatus(repo.root, { target: "missing" }), /unknown target/);
});

test("status defaults to main worktree branch from linked worktrees and handles detached targets", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const linked = path.join(testTempDir("status-linked"), "tree");
  git(repo.root, ["worktree", "add", "-qb", "topic", linked]);
  assert.equal(repositoryStatus(linked).target.branch, "main");
  assert.equal(repositoryStatus(repo.root, { target: "topic" }).target.worktree, linked);
  git(linked, ["checkout", "--detach", "-q"]);
  assert.equal(repositoryStatus(repo.root, { target: "topic" }).target.clean, null);
  git(repo.root, ["checkout", "--detach", "-q"]);
  assert.equal(repositoryStatus(repo.root).target.branch, "main");
  assert.equal(repositoryStatus(repo.root).last_land, null);
  assert.equal(existsSync(stateDir(repo.root)), false);
});
