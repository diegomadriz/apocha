// @ts-check
import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RunStore } from "../src/core/runs.mjs";
import { digestBetweenCommits, snapshotCandidate } from "../src/git/candidate.mjs";
import { landBranch } from "../src/git/land.mjs";
import { assertBatchRef, promoteCandidate, reserveBatchRef } from "../src/git/promotion.mjs";
import { verifyReceipt, writeReceipt } from "../src/git/receipts.mjs";
import { git, gitText, resolveCommit } from "../src/util/git.mjs";
import { testCandidate as createCandidate, makeRepo } from "./helpers.mjs";

const NOTES = "refs/notes/apocha";
const BATCH = "refs/heads/apocha/batch/t";

test("snapshot identity changes with content and is stable otherwise", () => {
  const repo = makeRepo();
  const candidate = createCandidate(repo.root, "main");
  try {
    writeFileSync(path.join(candidate.root, "src/value.txt"), "2\n");
    const a = snapshotCandidate(candidate);
    const b = snapshotCandidate(candidate);
    assert.equal(a.candidate_digest, b.candidate_digest);
    assert.deepEqual(a.changed_files, ["src/value.txt"]);
    writeFileSync(path.join(candidate.root, "src/value.txt"), "3\n");
    assert.notEqual(snapshotCandidate(candidate).candidate_digest, a.candidate_digest);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});

test("snapshots reject symlinks, hardlinks, ignored files, and hidden index flags", () => {
  const cases = [
    (root) => symlinkSync("/etc/hosts", path.join(root, "src", "link")),
    (root) => {
      writeFileSync(path.join(root, "src", "orig.txt"), "x");
      linkSync(path.join(root, "src", "orig.txt"), path.join(root, "src", "hard.txt"));
    },
    (root) => {
      writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
      git(root, ["add", ".gitignore"]);
      writeFileSync(path.join(root, "ignored.txt"), "hidden");
    },
    (root) => git(root, ["update-index", "--skip-worktree", "README.md"]),
  ];
  for (const [index, mutate] of cases.entries()) {
    const repo = makeRepo();
    const candidate = createCandidate(repo.root, "main");
    try {
      mutate(candidate.root);
      assert.throws(
        () => snapshotCandidate(candidate),
        (error) => error.errorClass === "integrity",
        `case ${index}`,
      );
    } finally {
      candidate.cleanup();
      repo.cleanup();
    }
  }
});

/** Promote a one-file change and return the pieces a receipt needs. */
function promoted(repo) {
  const candidate = createCandidate(repo.root, "main");
  writeFileSync(path.join(candidate.root, "src/value.txt"), "2\n");
  const snap = snapshotCandidate(candidate);
  reserveBatchRef(repo.root, BATCH, candidate.base_commit);
  const result = promoteCandidate({
    repositoryRoot: repo.root,
    candidate,
    verifiedDigest: snap.candidate_digest,
    batchRef: BATCH,
    message: "change",
  });
  candidate.cleanup();
  return { ...result, digest: snap.candidate_digest };
}

/** @param {any} p */
function receiptFor(p, overrides = {}) {
  const sha = "a".repeat(64);
  return {
    schema: "apocha.receipt.v3",
    generator: { name: "apocha", version: "0.1.0" },
    workflow: "code-delivery",
    run_id: "t-20261005T000000Z-abcd",
    task_id: "t1",
    task_digest: sha,
    promoted_head: p.promoted_head,
    tree: p.tree,
    parents: p.parents,
    base_commit: p.old_head,
    candidate_digest: p.digest,
    checks: [{ id: "test", status: "pass", definition_digest: sha, sandbox: "none" }],
    review: { decision: "PASS", findings: 0 },
    repairs: 0,
    agent_invocations: 2,
    retries: 0,
    runtimes: { implementer: null, reviewer: null },
    config_digest: sha,
    runtime_config_digest: sha,
    policy_digest: sha,
    governance: { edits_allowed: false, by: null, reason: null },
    ...overrides,
  };
}

test("promotion commits the verified candidate with the repository identity", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    assert.equal(resolveCommit(repo.root, BATCH), p.promoted_head);
    assert.equal(
      gitText(repo.root, ["log", "-1", "--format=%an <%ae>", p.promoted_head]),
      "Test User <test@example.invalid>",
    );
    assert.equal(digestBetweenCommits(repo.root, p.old_head, p.promoted_head), p.digest);
  } finally {
    repo.cleanup();
  }
});

test("promotion refuses a candidate that changed after verification", () => {
  const repo = makeRepo();
  const candidate = createCandidate(repo.root, "main");
  try {
    writeFileSync(path.join(candidate.root, "src/value.txt"), "2\n");
    const snap = snapshotCandidate(candidate);
    reserveBatchRef(repo.root, BATCH, candidate.base_commit);
    writeFileSync(path.join(candidate.root, "src/value.txt"), "9\n");
    assert.throws(
      () =>
        promoteCandidate({
          repositoryRoot: repo.root,
          candidate,
          verifiedDigest: snap.candidate_digest,
          batchRef: BATCH,
          message: "x",
        }),
      /changed after verification/,
    );
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});

test("batch refs must sit under the configured prefix and be canonical", () => {
  const repo = makeRepo();
  try {
    assert.throws(
      () => assertBatchRef(repo.root, "refs/heads/main", "refs/heads/apocha/batch/"),
      /must be under/,
    );
    assert.throws(
      () => assertBatchRef(repo.root, "refs/heads/apocha/batch/a..b", "refs/heads/apocha/batch/"),
      /canonical/,
    );
    assert.equal(assertBatchRef(repo.root, BATCH, "refs/heads/apocha/batch/"), BATCH);
    reserveBatchRef(repo.root, BATCH, /** @type {string} */ (resolveCommit(repo.root, "main")));
    assert.throws(
      () => reserveBatchRef(repo.root, BATCH, /** @type {string} */ (resolveCommit(repo.root, "main"))),
      /already exists/,
    );
  } finally {
    repo.cleanup();
  }
});

test("receipts verify against Git and detect tampering", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    writeReceipt(repo.root, NOTES, receiptFor(p));
    assert.equal(verifyReceipt(repo.root, NOTES, p.promoted_head).valid, true);
    assert.throws(() => writeReceipt(repo.root, NOTES, receiptFor(p)), /already exists/);

    const forge = (overrides) => {
      git(repo.root, [
        "notes",
        `--ref=${NOTES}`,
        "add",
        "-f",
        "-m",
        JSON.stringify(receiptFor(p, overrides)),
        p.promoted_head,
      ]);
      return verifyReceipt(repo.root, NOTES, p.promoted_head);
    };
    assert.match(forge({ candidate_digest: "b".repeat(64) }).reason ?? "", /candidate_digest/);
    assert.match(forge({ tree: p.old_head }).reason ?? "", /tree/);
    assert.match(forge({ review: { decision: "FIX", findings: 1 } }).reason ?? "", /schema/);
    assert.match(
      forge({ checks: [{ id: "x", status: "fail", definition_digest: "a".repeat(64), sandbox: "none" }] })
        .reason ?? "",
      /schema/,
    );
    assert.equal(verifyReceipt(repo.root, NOTES, p.old_head).reason, "missing receipt");
  } finally {
    repo.cleanup();
  }
});

test("legacy v1 and v2 receipts still verify, digest included", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    const legacy = {
      version: 2,
      task_id: "t1",
      promoted_head: p.promoted_head,
      tree: p.tree,
      parents: p.parents,
      base_commit: p.old_head,
      candidate_digest: p.digest,
      checks: [{ id: "x", status: "pass" }],
      review_decision: "PASS",
      repair_attempts: 0,
      implementer_invocations: 1,
      runtimes: { implementer: null, reviewer: null },
      governance_edits_allowed: false,
    };
    git(repo.root, ["notes", `--ref=${NOTES}`, "add", "-m", JSON.stringify(legacy), p.promoted_head]);
    const result = verifyReceipt(repo.root, NOTES, p.promoted_head);
    assert.equal(result.valid, true, result.reason ?? "");
    assert.equal(result.version, 2);
  } finally {
    repo.cleanup();
  }
});

test("land refuses unreceipted commits and fast-forwards receipted ones", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    assert.throws(
      () => landBranch({ repositoryRoot: repo.root, notesRef: NOTES, source: BATCH, target: "main" }),
      /no valid receipt/,
    );
    writeReceipt(repo.root, NOTES, receiptFor(p));
    // main is checked out in the fixture worktree: land fast-forwards it in place.
    const landed = landBranch({ repositoryRoot: repo.root, notesRef: NOTES, source: BATCH, target: "main" });
    assert.deepEqual(landed.commits, [p.promoted_head]);
    assert.equal(resolveCommit(repo.root, BATCH), null);
    assert.deepEqual(landed.retired, [{ ref: BATCH, oid: p.promoted_head }]);
    const record = JSON.parse(readFileSync(landed.record, "utf8"));
    assert.equal(record.target, "main");
    assert.equal(record.old_head, p.old_head);
    assert.equal(record.new_head, p.promoted_head);
    assert.deepEqual(record.commits, landed.commits);
    assert.deepEqual(record.retired, landed.retired);
    assert.equal(verifyReceipt(repo.root, NOTES, p.promoted_head).valid, true);
    assert.equal(gitText(repo.root, ["rev-parse", "HEAD"]), p.promoted_head);
    assert.equal(gitText(repo.root, ["show", "HEAD:src/value.txt"]), "2");
  } finally {
    repo.cleanup();
  }
});

test("land preserves batch refs requested, checked out, active, or outside the prefix", () => {
  for (const reason of ["keep-batch", "worktree", "RUNNING", "PAUSED", "prefix", "target"]) {
    const repo = makeRepo();
    try {
      const p = promoted(repo);
      writeReceipt(repo.root, NOTES, receiptFor(p));
      if (reason === "worktree")
        git(repo.root, ["worktree", "add", path.join(repo.root, "checkout"), "apocha/batch/t"]);
      if (reason === "RUNNING" || reason === "PAUSED")
        new RunStore(repo.root).create("active-20261005T000000Z-abcd", {
          batch_ref: BATCH,
          outcome: reason,
        });
      const result = landBranch({
        repositoryRoot: repo.root,
        notesRef: NOTES,
        source: BATCH,
        target: reason === "target" ? "apocha/batch/t" : "main",
        keepBatch: reason === "keep-batch",
        batchPrefix: reason === "prefix" ? "refs/heads/other/" : undefined,
      });
      assert.equal(resolveCommit(repo.root, BATCH), p.promoted_head, reason);
      assert.equal(result.retired.length, 0, reason);
      assert.equal(result.kept.length, 1, reason);
      assert.match(result.kept[0].reason, /keep-batch|worktree|RUNNING|PAUSED|prefix|target/);
    } finally {
      repo.cleanup();
    }
  }
});

test("land keeps and reports a source ref moved by the target's post-merge hook", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    writeReceipt(repo.root, NOTES, receiptFor(p));
    writeFileSync(
      path.join(repo.root, ".git/hooks/post-merge"),
      `#!/bin/sh
git update-ref ${BATCH} ${p.old_head} ${p.promoted_head}
`,
      { mode: 0o755 },
    );
    const result = landBranch({
      repositoryRoot: repo.root,
      notesRef: NOTES,
      source: BATCH,
      target: "main",
    });
    assert.equal(resolveCommit(repo.root, "main"), p.promoted_head);
    assert.equal(resolveCommit(repo.root, BATCH), p.old_head);
    assert.deepEqual(result.retired, []);
    assert.deepEqual(result.kept, [{ ref: BATCH, oid: p.promoted_head, reason: "ref moved" }]);
    assert.deepEqual(JSON.parse(readFileSync(result.record, "utf8")).kept, result.kept);
  } finally {
    repo.cleanup();
  }
});

test("land retires integrated topic batches and preserves moved topics", () => {
  for (const moved of [false, true]) {
    const repo = makeRepo();
    try {
      const topic = promoted(repo);
      writeReceipt(repo.root, NOTES, receiptFor(topic));
      const store = new RunStore(repo.root);
      store.create("t1-20261005T000000Z-abcd", {
        batch_ref: BATCH,
        promoted_head: topic.promoted_head,
        outcome: "PASSED",
      });
      const head = gitText(repo.root, [
        "commit-tree",
        topic.tree,
        "-p",
        topic.old_head,
        "-p",
        topic.promoted_head,
        "-m",
        "Integrate topic",
      ]);
      const integration = "refs/heads/apocha/batch/integration";
      git(repo.root, ["update-ref", integration, head]);
      writeReceipt(
        repo.root,
        NOTES,
        receiptFor(
          {
            ...topic,
            promoted_head: head,
            parents: [topic.old_head, topic.promoted_head],
            digest: digestBetweenCommits(repo.root, topic.old_head, head),
          },
          { workflow: "integrate" },
        ),
      );
      if (moved) git(repo.root, ["update-ref", BATCH, topic.old_head]);
      const result = landBranch({
        repositoryRoot: repo.root,
        notesRef: NOTES,
        source: integration,
        target: "main",
      });
      assert.equal(resolveCommit(repo.root, integration), null);
      assert.equal(resolveCommit(repo.root, BATCH), moved ? topic.old_head : null);
      if (moved) assert.equal(result.kept[0].reason, "ref moved");
      else assert.ok(result.retired.some((entry) => entry.ref === BATCH));
      assert.equal(verifyReceipt(repo.root, NOTES, head).valid, true);
      assert.equal(verifyReceipt(repo.root, NOTES, topic.promoted_head).valid, true);
    } finally {
      repo.cleanup();
    }
  }
});

test("land refuses a dirty target worktree and non-fast-forward sources", () => {
  const repo = makeRepo();
  try {
    const p = promoted(repo);
    writeReceipt(repo.root, NOTES, receiptFor(p));
    writeFileSync(path.join(repo.root, "README.md"), "dirty\n");
    assert.throws(
      () => landBranch({ repositoryRoot: repo.root, notesRef: NOTES, source: BATCH, target: "main" }),
      /tracked changes/,
    );
    git(repo.root, ["checkout", "--", "README.md"]);
    mkdirSync(path.join(repo.root, "x"), { recursive: true });
    git(repo.root, ["commit", "-q", "--allow-empty", "-m", "diverge"]);
    assert.throws(
      () => landBranch({ repositoryRoot: repo.root, notesRef: NOTES, source: BATCH, target: "main" }),
      /not an ancestor/,
    );
  } finally {
    repo.cleanup();
  }
});
