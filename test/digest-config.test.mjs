// @ts-check
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../src/core/run.mjs";
import { digestBetweenCommits, identityDigest, snapshotCandidate } from "../src/git/candidate.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { git, gitText } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testCandidate,
  valueTask,
  writeValue,
} from "./helpers.mjs";

/** @param {import("node:test").TestContext} t */
function cleanConfig(t) {
  const overrides = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_DIFF_OPTS: "",
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Original digest call semantics, intentionally without the new pinned options.
 * @param {string} root
 * @param {string} base
 * @param {string[]} refs
 */
function legacySnapshot(root, base, refs) {
  const names = String(git(root, ["diff", ...refs, "--no-renames", "--name-only", "-z", "--"]).stdout);
  const changedFiles = names.split("\0").filter(Boolean).sort();
  const diff = String(
    git(root, [
      "diff",
      ...refs,
      "--no-renames",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--",
    ]).stdout,
  ).replaceAll("\r\n", "\n");
  return { diff, digest: identityDigest(base, changedFiles, diff) };
}

const hostileDiff = {
  "diff.noprefix": "true",
  "diff.mnemonicPrefix": "true",
  "diff.relative": "true",
  "diff.context": "10",
  "diff.interHunkContext": "8",
  "diff.algorithm": "patience",
  "diff.suppressBlankEmpty": "true",
  "diff.indentHeuristic": "false",
  "core.quotePath": "false",
  "color.diff": "always",
  "diff.renames": "copies",
  "diff.external": "false",
  "diff.hostile.textconv": "echo converted",
};

test("pinned digests preserve default Git bytes for mixed index and commit changes", (t) => {
  cleanConfig(t);
  const repo = makeRepo({
    files: {
      "src/deleted.txt": "delete me\n",
      "src/spaces é.txt": "old name content\n",
      "src/binary.bin": "\0old\xff",
    },
  });
  const candidate = testCandidate(repo.root, "main");
  try {
    writeFileSync(path.join(candidate.root, "src/value.txt"), "2\n");
    writeFileSync(path.join(candidate.root, "src/added.txt"), "added\n");
    rmSync(path.join(candidate.root, "src/deleted.txt"));
    writeFileSync(path.join(candidate.root, "src/spaces é.txt"), "new name content\n");
    writeFileSync(path.join(candidate.root, "src/binary.bin"), Buffer.from([0, 255, 1]));
    git(candidate.root, ["add", "--all"]);
    const old = legacySnapshot(candidate.root, candidate.base_commit, ["--cached", candidate.base_commit]);
    const snapshot = snapshotCandidate(candidate);
    assert.deepEqual(snapshot.changed_files, [
      "src/added.txt",
      "src/binary.bin",
      "src/deleted.txt",
      "src/spaces é.txt",
      "src/value.txt",
    ]);
    assert.match(old.diff, /GIT binary patch/);
    assert.equal(snapshot.diff, old.diff);
    assert.equal(snapshot.candidate_digest, old.digest);
    const tree = gitText(candidate.root, ["write-tree"]);
    const head = gitText(candidate.root, [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      tree,
      "-p",
      candidate.base_commit,
      "-m",
      "mixed change",
    ]);
    assert.equal(
      legacySnapshot(candidate.root, candidate.base_commit, [candidate.base_commit, head]).digest,
      old.digest,
    );
    assert.equal(digestBetweenCommits(candidate.root, candidate.base_commit, head), old.digest);

    for (const [key, value] of Object.entries(hostileDiff)) {
      git(candidate.root, ["config", key, value]);
    }
    writeFileSync(path.join(candidate.root, ".git/info/attributes"), "*.txt diff=hostile\n");
    process.env.GIT_DIFF_OPTS = "--unified=20";
    assert.equal(snapshotCandidate(candidate).candidate_digest, old.digest);
    assert.equal(digestBetweenCommits(candidate.root, candidate.base_commit, head), old.digest);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});

test("a promoted fake-adapter receipt verifies under hostile global Git configuration", async (t) => {
  cleanConfig(t);
  const repo = makeRepo();
  try {
    const fake = createFakeAdapter({
      handlers: { implementer: writeValue(2), reviewer: passReviewer },
    });
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "set-value",
      message: "Set value to 2",
      runtimes: fakeRuntimes(),
      task: valueTask(),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    const head = /** @type {string} */ (summary.promoted_head);
    const before = verifyReceipt(repo.root, "refs/notes/apocha", head);
    assert.equal(before.valid, true, before.reason ?? "");

    const globalConfig = path.join(repo.root, ".git/hostile-global");
    const attributes = path.join(repo.root, ".git/hostile-attributes");
    writeFileSync(globalConfig, "");
    writeFileSync(attributes, "*.txt diff=hostile\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    for (const [key, value] of Object.entries(hostileDiff)) {
      git(repo.root, ["config", "--global", key, value]);
    }
    git(repo.root, ["config", "--global", "core.attributesFile", attributes]);

    const receipt = before.receipt;
    // Prove the old call path would reject this same receipt.
    assert.notEqual(
      legacySnapshot(repo.root, receipt.base_commit, [receipt.base_commit, head]).digest,
      receipt.candidate_digest,
    );
    const after = verifyReceipt(repo.root, "refs/notes/apocha", head);
    assert.equal(after.valid, true, after.reason ?? "");
    assert.equal(digestBetweenCommits(repo.root, receipt.base_commit, head), receipt.candidate_digest);
  } finally {
    repo.cleanup();
  }
});
