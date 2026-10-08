// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { verifyReceipt, writeReceipt } from "../src/git/receipts.mjs";
import { describeError, HarnessError } from "../src/util/errors.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

test("duplicate receipt on a controller-promoted commit explains identical runs", async () => {
  const repo = makeRepo();
  try {
    const fake = createFakeAdapter({
      handlers: { implementer: writeValue(2), reviewer: passReviewer },
    });
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "receipt-exists",
      message: "Set value to 2",
      task: valueTask(),
      runtimes: fakeRuntimes(),
      adapters: { implementer: fake, reviewer: fake },
    });
    assert.equal(summary.outcome, "PASSED");
    assert.ok(summary.promoted_head);
    const commit = summary.promoted_head;
    const notesRef = loadProjectConfig(repo.root).refs.notes;
    const verified = verifyReceipt(repo.root, notesRef, commit);
    assert.equal(verified.valid, true);
    assert.throws(
      () => writeReceipt(repo.root, notesRef, verified.receipt),
      (error) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(describeError(error).error_class, "integrity");
        assert.equal(error.code, "receipt_exists");
        assert.ok(error.message.includes(commit));
        assert.match(error.message, /another run already produced and receipted this exact commit/);
        assert.match(
          error.message,
          /two runs making the identical change with the same message in the same second produce the same commit/,
        );
        assert.match(error.message, /the existing receipt still covers it/);
        return true;
      },
    );
    assert.deepEqual(verifyReceipt(repo.root, notesRef, commit), verified);
  } finally {
    repo.cleanup();
  }
});
