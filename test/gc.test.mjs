// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectRunFacts } from "../src/analytics/collect.mjs";
import { applyGc, planGc } from "../src/core/gc.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { git, gitCommonDir, gitText, resolveCommit } from "../src/util/git.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/panagent.mjs", import.meta.url));

test("gc dry run and apply preserve active refs and analytics and remove only eligible artifacts", async () => {
  const repo = makeRepo();
  const temporary = testTempDir("gc");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  try {
    const prefix = "refs/heads/panagent/batch/";
    const base = gitText(repo.root, ["rev-parse", "HEAD"]);
    for (const name of ["merged", "checked", "paused", "running", "moved"])
      git(repo.root, ["update-ref", prefix + name, base]);
    git(repo.root, ["checkout", "-qb", "panagent/batch/unmerged"]);
    writeFileSync(path.join(repo.root, "extra.txt"), "unmerged");
    git(repo.root, ["add", "extra.txt"]);
    git(repo.root, ["commit", "-qm", "unmerged"]);
    const unmerged = gitText(repo.root, ["rev-parse", "HEAD"]);
    git(repo.root, ["checkout", "-q", "main"]);
    git(repo.root, ["worktree", "add", "-q", path.join(temporary, "checkout"), "panagent/batch/checked"]);
    git(repo.root, ["update-ref", "refs/heads/outside", base]);
    const store = new RunStore(repo.root);
    const paused = "paused-20260101T000000Z-0001";
    const running = "running-20260101T000000Z-0002";
    const finished = "finished-20260101T000000Z-0003";
    store.create(paused, {
      outcome: "PAUSED",
      batch_ref: prefix + "paused",
      base_commit: base,
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2020-01-01T00:00:00Z",
    });
    store.create(running, { outcome: "RUNNING", batch_ref: prefix + "running", pid: 2147483647 });
    store.create(finished, {
      outcome: "PASSED",
      workflow: "code-delivery",
      task_id: "finished",
      finished_at: "2020-01-01T00:00:00Z",
    });
    store.event(finished, "check.finished", { id: "test", status: "pass" });
    store.writeReport(finished, { outcome: "PASSED" });
    writeFileSync(path.join(store.dir(finished), "verification-0.json"), "{}");
    for (const index of [1, 2]) {
      const session = store.sessionDir(finished, index);
      writeFileSync(path.join(session, "session.json"), JSON.stringify({ role: "implementer" }));
      writeFileSync(path.join(session, "tools.jsonl"), '{"tool":"run_check","ok":true,"status":"pass"}\n');
    }
    const makeTemp = (name, pid, runId = null) => {
      const directory = path.join(temporary, `panagent-${name}`);
      mkdirSync(directory);
      writeFileSync(
        path.join(directory, ".panagent-owner"),
        JSON.stringify({
          kind: "candidate",
          run_id: runId,
          pid,
          created_at: "2020-01-01T00:00:00Z",
          repository: realpathSync(gitCommonDir(repo.root)),
        }),
      );
      return directory;
    };
    const live = makeTemp("live", process.pid);
    const dead = makeTemp("dead", 2147483647);
    const candidate = makeTemp("paused", 2147483647, paused);
    store.update(paused, { candidate_root: path.join(candidate, "tree") });
    const legacy = path.join(temporary, "panagent-legacy");
    mkdirSync(legacy);
    utimesSync(legacy, new Date("2020-01-01"), new Date("2020-01-01"));
    const young = path.join(temporary, "panagent-young");
    mkdirSync(young);
    const foreign = path.join(temporary, "foreign");
    mkdirSync(foreign);
    symlinkSync(foreign, path.join(temporary, "panagent-link"));
    const before = collectRunFacts(repo.root);
    const snapshot = readFileSync(path.join(store.dir(paused), "run.json"), "utf8");
    const dry = spawnSync(process.execPath, [BIN, "gc"], { cwd: repo.root, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry run/);
    assert.match(dry.stdout, /ref:.*bytes/);
    assert.ok(dry.stdout.includes(base));
    assert.equal(readFileSync(path.join(store.dir(paused), "run.json"), "utf8"), snapshot);
    assert.ok(existsSync(dead));
    assert.ok(existsSync(path.join(store.dir(finished), "sessions", "001")));
    assert.equal(resolveCommit(repo.root, prefix + "merged"), base);
    assert.equal(existsSync(path.join(store.root, "..", "gc")), false);
    const plan = planGc(repo.root);
    git(repo.root, ["update-ref", prefix + "moved", unmerged, base]);
    const result = await applyGc(repo.root, plan);
    assert.equal(resolveCommit(repo.root, prefix + "merged"), null);
    for (const name of ["checked", "paused", "running"])
      assert.equal(resolveCommit(repo.root, prefix + name), base);
    assert.equal(resolveCommit(repo.root, prefix + "unmerged"), unmerged);
    assert.equal(resolveCommit(repo.root, prefix + "moved"), unmerged);
    assert.equal(resolveCommit(repo.root, "outside"), base);
    for (const directory of [live, candidate, young, foreign]) assert.ok(existsSync(directory));
    for (const directory of [dead, legacy]) assert.equal(existsSync(directory), false);
    assert.deepEqual(readdirSync(path.join(store.dir(finished), "sessions")), []);
    for (const name of ["run.json", "events.jsonl", "report.json", "verification-0.json"])
      assert.ok(existsSync(path.join(store.dir(finished), name)));
    assert.deepEqual(collectRunFacts(repo.root), before);
    assert.ok(existsSync(result.record));
    assert.equal(JSON.parse(readFileSync(result.record, "utf8")).done.length, result.done.length);
    assert.deepEqual(collectRunFacts(repo.root), before);
    writeFileSync(
      path.join(store.dir(paused), "run.json"),
      JSON.stringify({ ...store.read(paused), updated_at: "2020-01-01T00:00:00Z" }),
    );
    const abandon = planGc(repo.root, { abandonPausedDays: 30 });
    assert.equal(store.read(paused).outcome, "PAUSED");
    await applyGc(repo.root, abandon);
    assert.equal(store.read(paused).outcome, "ERROR");
    assert.equal(store.read(paused).error_class, "infra");
    assert.equal(store.read(paused).code, "abandoned");
    assert.equal(resolveCommit(repo.root, prefix + "paused"), null);
    assert.equal(existsSync(candidate), false);
    assert.ok(
      store.events(paused).some((event) => event.type === "run.finished" && event.code === "abandoned"),
    );
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    repo.cleanup();
  }
});

test("gc scopes dead owners to the repository and protects legacy run candidates", async (t) => {
  const repo = makeRepo();
  const other = makeRepo();
  t.after(repo.cleanup);
  t.after(other.cleanup);
  const temporary = testTempDir("gc-scope");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  const ownRepository = realpathSync(gitCommonDir(repo.root));
  const otherRepository = realpathSync(gitCommonDir(other.root));
  const makeTemp = (name, repository, pid = 2147483647) => {
    const directory = path.join(temporary, `panagent-${name}`);
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, ".panagent-owner"),
      JSON.stringify({
        kind: "candidate",
        run_id: null,
        pid,
        created_at: "2020-01-01T00:00:00Z",
        repository,
      }),
    );
    return directory;
  };
  const own = makeTemp("own", ownRepository);
  const foreign = makeTemp("other", otherRepository);
  const live = makeTemp("live", ownRepository, process.pid);
  const legacyOwner = makeTemp("legacy-owner", undefined);
  const youngLegacy = makeTemp("young-legacy", undefined);
  const legacy = path.join(temporary, "panagent-unowned");
  const candidate = path.join(temporary, "panagent-legacy-candidate");
  mkdirSync(legacy);
  mkdirSync(candidate);
  for (const directory of [legacyOwner, legacy, candidate])
    utimesSync(directory, new Date("2020-01-01"), new Date("2020-01-01"));
  const store = new RunStore(repo.root);
  store.create("finished-20260101T000000Z-0005", {
    outcome: "PASSED",
    candidate_root: path.join(candidate, "tree"),
  });
  const otherStore = new RunStore(other.root);
  otherStore.create("paused-20260101T000000Z-0006", {
    outcome: "PAUSED",
    candidate_root: path.join(foreign, "tree"),
  });
  const plan = planGc(repo.root, { abandonPausedDays: 0 });
  for (const directory of [foreign, live, youngLegacy, candidate])
    assert.equal(
      plan.items.some((item) => item.path === directory),
      false,
    );
  for (const directory of [own, legacyOwner, legacy])
    assert.ok(plan.items.some((item) => item.path === directory));
  await applyGc(repo.root, plan);
  for (const directory of [foreign, live, youngLegacy, candidate]) assert.ok(existsSync(directory));
  for (const directory of [own, legacyOwner, legacy]) assert.equal(existsSync(directory), false);
});

test("gc validates day options and rejects session paths through symlinks", () => {
  const repo = makeRepo();
  const outside = testTempDir("gc-outside");
  try {
    for (const keepDays of [-1, NaN, Infinity])
      assert.throws(() => planGc(repo.root, { keepDays }), /nonnegative/);
    assert.throws(() => planGc(repo.root, { abandonPausedDays: -1 }), /nonnegative/);
    const store = new RunStore(repo.root);
    const id = "symlink-20260101T000000Z-0004";
    store.create(id, { outcome: "ERROR", finished_at: "2020-01-01T00:00:00Z" });
    symlinkSync(outside, path.join(store.dir(id), "sessions"));
    assert.throws(() => planGc(repo.root), /symlink/);
    assert.ok(existsSync(outside));
  } finally {
    repo.cleanup();
  }
});
