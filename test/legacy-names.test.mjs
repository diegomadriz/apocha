// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProjectConfig, loadProjectConfigAt } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { git, gitText } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const NOTES = "refs/notes/apocha";

test("a repository still configured with panagent.config.json loads and protects both names", () => {
  const repo = makeRepo();
  try {
    git(repo.root, ["mv", "apocha.config.json", "panagent.config.json"]);
    git(repo.root, ["commit", "-qm", "legacy config name"]);
    const config = loadProjectConfig(repo.root);
    assert.deepEqual(config.default_checks, ["test"]);
    assert.deepEqual(loadProjectConfigAt(repo.root, "HEAD").default_checks, ["test"]);
    for (const name of ["apocha.config.json", "panagent.config.json", ".apocha/", ".panagent/"])
      assert.ok(config.paths.governance.includes(name), `${name} is a governance path`);
  } finally {
    repo.cleanup();
  }
});

test("apocha.config.json wins over a legacy panagent.config.json", () => {
  const legacy = {
    version: 1,
    checks: { ok: { run: ["node", "-e", "0"], cwd: "." } },
    default_checks: ["ok"],
  };
  const repo = makeRepo({ files: { "panagent.config.json": `${JSON.stringify(legacy)}\n` } });
  try {
    assert.deepEqual(loadProjectConfig(repo.root).default_checks, ["test"]);
  } finally {
    repo.cleanup();
  }
});

test("receipts written as panagent.receipt.v3 still verify; unknown schema ids do not", async () => {
  const repo = makeRepo();
  try {
    const fake = createFakeAdapter({ handlers: { implementer: writeValue(2), reviewer: passReviewer } });
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
    const receipt = JSON.parse(gitText(repo.root, ["notes", `--ref=${NOTES}`, "show", head]));
    assert.equal(receipt.schema, "apocha.receipt.v3");
    const rewrite = (/** @type {string} */ schema) =>
      git(repo.root, ["notes", `--ref=${NOTES}`, "add", "-f", "-F", "-", head], {
        input: JSON.stringify({ ...receipt, schema }),
      });
    rewrite("panagent.receipt.v3");
    const legacy = verifyReceipt(repo.root, NOTES, head);
    assert.equal(legacy.valid, true, legacy.reason ?? "");
    assert.equal(legacy.version, 3);
    rewrite("other.receipt.v3");
    assert.equal(verifyReceipt(repo.root, NOTES, head).valid, false);
  } finally {
    repo.cleanup();
  }
});
