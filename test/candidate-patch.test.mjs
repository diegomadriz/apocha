// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyGc, planGc } from "../src/core/gc.mjs";
import { resumeRun, startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { repositoryStatus } from "../src/core/status.mjs";
import { sha256 } from "../src/util/digest.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git, gitBuffer } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testCandidate,
  valueTask,
} from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));

/** @param {string} root @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer] */
function options(root, implementer, reviewer = passReviewer) {
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  return {
    cwd: root,
    base: "main",
    batch: "patch",
    message: "Candidate patch",
    runtimes: fakeRuntimes(),
    task: valueTask({ max_repair_attempts: 0 }),
    adapters: { implementer: fake, reviewer: fake },
  };
}

/** @param {string} root @param {Record<string, any>} summary */
function patchOf(root, summary) {
  const store = new RunStore(root);
  const record = store.read(summary.run_id);
  const report = JSON.parse(readFileSync(path.join(store.dir(summary.run_id), "report.json"), "utf8"));
  assert.deepEqual(record.candidate_patch, summary.candidate_patch);
  assert.deepEqual(report.candidate_patch, summary.candidate_patch);
  const file = path.join(store.dir(summary.run_id), "candidate.patch");
  const diff = readFileSync(file);
  assert.deepEqual(summary.candidate_patch, {
    path: "candidate.patch",
    bytes: diff.length,
    files: 2,
    sha256: sha256(diff),
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(record.candidate_root), false);
  const checkout = testCandidate(root, summary.base_commit);
  git(checkout.root, ["apply", "--binary", file]);
  return { store, file, diff, checkout };
}

for (const mode of ["blocked", "checks", "passed", "binary", "failed", "error"]) {
  test(`final candidate patch round-trips ${mode} runs`, async () => {
    const repo = makeRepo({ files: { "src/new.bin": "base\0bytes\r\n" } });
    const originalIndex = readFileSync(path.join(repo.root, ".git", "index"));
    const controller = new AbortController();
    const binary = mode === "binary";
    const next = binary ? Buffer.from([0, 255, 13, 10, 42]) : Buffer.from("new file\n");
    const newPath = binary ? "src/new.bin" : mode === "failed" ? "README.md" : "src/new.txt";
    const summary = await startRun({
      ...options(
        repo.root,
        async ({ call, root }) => {
          await call("read_files", { paths: ["src/value.txt"] });
          await call("apply_patch", {
            edits: [{ path: "src/value.txt", old_text: "1\n", new_text: mode === "checks" ? "3\n" : "2\n" }],
          });
          if (binary || mode === "failed") writeFileSync(path.join(root, newPath), next);
          else
            await call("apply_patch", {
              edits: [{ path: newPath, old_text: "", new_text: next.toString() }],
            });
          // Deliberately hostile local diff settings must not affect the archive.
          git(root, ["config", "diff.noprefix", "true"]);
          git(root, ["config", "diff.context", "0"]);
          await call(
            "submit_result",
            mode === "blocked"
              ? {
                  status: "blocked",
                  blocked_reason: "check.mjs conflicts with task",
                  summary: "blocked",
                }
              : { summary: "done" },
          );
          if (mode === "error") controller.abort();
        },
        mode === "blocked"
          ? async ({ bundle, call }) => {
              await call("submit_result", {
                decision: "ESCALATE",
                findings: [],
                reason: "confirmed conflict",
                candidate_digest: bundle.candidate.candidate_digest,
              });
            }
          : passReviewer,
      ),
      signal: controller.signal,
    });
    assert.equal(
      summary.outcome,
      ["blocked", "checks"].includes(mode)
        ? "ESCALATED"
        : mode === "failed"
          ? "FAILED"
          : mode === "error"
            ? "ERROR"
            : "PASSED",
      summary.reason ?? "",
    );
    const { store, file, diff, checkout } = patchOf(repo.root, summary);
    assert.equal(
      readFileSync(path.join(checkout.root, "src/value.txt"), "utf8"),
      mode === "checks" ? "3\n" : "2\n",
    );
    assert.deepEqual(readFileSync(path.join(checkout.root, newPath)), next);
    assert.deepEqual(readFileSync(path.join(repo.root, ".git", "index")), originalIndex);
    if (summary.outcome === "PASSED") {
      assert.deepEqual(
        diff,
        gitBuffer(repo.root, [
          "diff",
          "--no-renames",
          "--binary",
          "--full-index",
          summary.base_commit,
          summary.promoted_head,
          "--",
        ]),
      );
    }
    const json = spawnSync(process.execPath, [BIN, "status", summary.run_id, "--json"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).candidate_patch, summary.candidate_patch);
    const text = spawnSync(process.execPath, [BIN, "status", summary.run_id], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(file));

    if (mode === "blocked") {
      store.update(summary.run_id, { finished_at: "2020-01-01T00:00:00Z" });
      const plan = planGc(repo.root, { keepDays: 0 });
      assert.ok(plan.items.some((item) => item.kind === "session"));
      await applyGc(repo.root, plan);
      assert.deepEqual(readFileSync(file), diff);
      const size = repositoryStatus(repo.root).disk.run_store_size;
      rmSync(file);
      assert.equal(size - repositoryStatus(repo.root).disk.run_store_size, diff.length);
      rmSync(store.dir(summary.run_id), { recursive: true });
      assert.equal(existsSync(file), false);
    }
  });
}

test("unchanged finished run records null without a patch file", async () => {
  const repo = makeRepo();
  const summary = await startRun(
    options(repo.root, async ({ call }) => {
      await call("submit_result", { summary: "unchanged" });
    }),
  );
  const store = new RunStore(repo.root);
  assert.equal(summary.candidate_patch, null);
  assert.equal(store.read(summary.run_id).candidate_patch, null);
  assert.equal(
    JSON.parse(readFileSync(path.join(store.dir(summary.run_id), "report.json"), "utf8")).candidate_patch,
    null,
  );
  assert.equal(existsSync(path.join(store.dir(summary.run_id), "candidate.patch")), false);
});

test("patch write failure preserves PASSED and records the error", async () => {
  const repo = makeRepo();
  const store = new RunStore(repo.root);
  const summary = await startRun(
    options(repo.root, async ({ call }) => {
      await call("read_files", { paths: ["src/value.txt"] });
      await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      mkdirSync(path.join(store.dir(store.list()[0].run_id), "candidate.patch"));
      await call("submit_result", { summary: "done" });
    }),
  );
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.equal(summary.candidate_patch, null);
  assert.ok(summary.candidate_patch_error);
  assert.equal(store.read(summary.run_id).candidate_patch_error, summary.candidate_patch_error);
  const report = JSON.parse(readFileSync(path.join(store.dir(summary.run_id), "report.json"), "utf8"));
  assert.equal(report.candidate_patch_error, summary.candidate_patch_error);
  assert.equal(report.outcome, "PASSED");
});

test("start and resume exception paths archive the candidate before cleanup", async () => {
  for (const resume of [false, true]) {
    const repo = makeRepo();
    const store = new RunStore(repo.root);
    const opts = options(repo.root, async () => {
      throw new HarnessError("usage_limited", "limit", "usage limit");
    });
    if (resume) {
      const paused = await startRun(opts);
      assert.equal(paused.outcome, "PAUSED");
      assert.equal(paused.candidate_patch, null);
      assert.equal(existsSync(path.join(store.dir(paused.run_id), "candidate.patch")), false);
    }
    const onEvent = () => {
      const record = store.list()[0];
      writeFileSync(path.join(record.candidate_root, "src/value.txt"), "2\n");
      writeFileSync(path.join(record.candidate_root, "src/new.txt"), "exception\n");
      throw new Error("injected event failure");
    };
    await assert.rejects(
      resume
        ? resumeRun({
            cwd: repo.root,
            runId: store.list()[0].run_id,
            runtimes: fakeRuntimes(),
            adapters: opts.adapters,
            onEvent,
          })
        : startRun({ ...opts, onEvent }),
      /injected event failure/,
    );
    const record = store.list()[0];
    assert.equal(record.outcome, "ERROR");
    const { checkout } = patchOf(repo.root, record);
    assert.equal(readFileSync(path.join(checkout.root, "src/new.txt"), "utf8"), "exception\n");
  }
});
