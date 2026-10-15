// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runFixers } from "../src/checks/fixers.mjs";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { initialState } from "../src/core/context.mjs";
import { detectBackend } from "../src/sandbox/index.mjs";
import { runChecksStage } from "../src/stages/checks.mjs";
import { git } from "../src/util/git.mjs";
import { forbiddenDenyPaths, forbiddenMaterializedPaths } from "../src/util/paths.mjs";
import { makeRepo, testCandidate, testTempDir } from "./helpers.mjs";

function fixture() {
  const repo = makeRepo();
  // Two Git moves preserve the new index spelling even on case-insensitive disks.
  git(repo.root, ["mv", "private", "intermediate"]);
  git(repo.root, ["mv", "intermediate", "Private"]);
  git(repo.root, ["commit", "-qm", "capitalize private"]);
  const config = normalizeProjectConfig(
    {
      version: 1,
      paths: { forbidden: ["private/"] },
      checks: { probe: { run: ["node", "-e", "process.exit(0)"] } },
      fixers: { format: { run: ["node", "-e", "throw new Error('fixer must not run')", "{files}"] } },
      default_fixers: ["format"],
      sandbox: { mode: "none" },
    },
    repo.root,
  );
  return { repo, config, candidate: testCandidate(repo.root, "main") };
}

test("materialization selects forbidden index files regardless of case", () => {
  assert.deepEqual(
    forbiddenMaterializedPaths(
      ["Private/secret.txt", "PRIVATE/x", "privateer/x", "src/value.txt", "TOKEN"],
      ["private/", "token"],
    ),
    ["Private/secret.txt", "PRIVATE/x", "TOKEN"],
  );
});

test("host deny list includes literal and on-disk spellings of each scope component", () => {
  const root = testTempDir("forbidden-spelling");
  mkdirSync(path.join(root, "Private", "Nested"), { recursive: true });
  writeFileSync(path.join(root, "Private", "Nested", "Token"), "secret");
  const denied = forbiddenDenyPaths(root, ["private/", "PRIVATE/nested/token", "missing/"]);
  for (const relative of ["private", "Private", "PRIVATE/nested/token", "Private/Nested/Token", "missing"])
    assert.ok(denied.includes(path.join(root, relative)), relative);
});

test("both materialization branches exclude mixed-case forbidden files", async () => {
  const { candidate, config } = fixture();
  for (const baseOverlay of [undefined, ["src/value.txt"]]) {
    const result = await runCheck({
      candidate,
      config,
      backend: "none",
      baseOverlay,
      check: config.checks.probe,
      onPrepared: (root) => assert.equal(existsSync(path.join(root, "Private/secret.txt")), false),
    });
    assert.equal(result.status, "pass", result.error ?? result.stderr);
  }
});

test("base-overlay files cannot restore a mixed-case forbidden base file", async () => {
  const { candidate, config } = fixture();
  const result = await runCheck({
    candidate,
    config,
    backend: "none",
    check: config.checks.probe,
    baseOverlay: ["src/value.txt"],
    baseFiles: ["Private/secret.txt"],
  });
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /base file is forbidden: Private\/secret.txt/);
});

test("fixers never target uppercase forbidden files", async () => {
  const { candidate, config } = fixture();
  mkdirSync(path.join(candidate.root, "PRIVATE"), { recursive: true });
  writeFileSync(path.join(candidate.root, "PRIVATE/x"), "original");
  const ctx = /** @type {any} */ ({
    candidate,
    config,
    sandboxBackend: "none",
    event: () => {},
    task: { allowed_paths: ["PRIVATE/"], protected_paths: [], read_only_paths: [], design_reference: [] },
  });
  const [result] = await runFixers(ctx, ["PRIVATE/x"]);
  assert.equal(result.status, "skipped");
  assert.deepEqual(result.changed, []);
  assert.equal(readFileSync(path.join(candidate.root, "PRIVATE/x"), "utf8"), "original");
});

test("a mixed-case forbidden candidate change fails protected-paths", async () => {
  const { candidate, config } = fixture();
  writeFileSync(path.join(candidate.root, "Private/x"), "changed");
  const ctx = /** @type {any} */ ({
    candidate,
    config,
    sandboxBackend: "none",
    event: () => {},
    task: {
      fixers: [],
      allowed_paths: ["Private/"],
      protected_paths: [],
      read_only_paths: [],
      design_reference: [],
      checks: ["probe"],
      test_edits: "additive",
    },
    governance: { edits_allowed: true },
    state: initialState("checks"),
    runId: "fixture",
    store: { dir: () => testTempDir("forbidden-verification") },
  });
  assert.equal(await runChecksStage(/** @type {any} */ (null), ctx), "violation");
  const check = ctx.state.last_verification.checks.find((entry) => entry.id === "protected-paths");
  assert.equal(check.status, "fail");
  assert.deepEqual(check.files, ["Private/x"]);
});

const backend = detectBackend();
test("a real sandbox blocks mixed-case forbidden source and materialized reads", {
  skip: backend ? false : "no sandbox backend on this host",
}, async () => {
  const { candidate, config } = fixture();
  const script = `const fs = require("node:fs");
const path = require("node:path");
for (const root of [process.argv[1], process.cwd()]) {
  let readable = false;
  try { fs.readFileSync(path.join(root, "Private/secret.txt")); readable = true; } catch {}
  if (readable) throw new Error("forbidden file readable: " + root);
}
console.log("both blocked");`;
  const result = await runCheck({
    candidate,
    config,
    backend: /** @type {"seatbelt" | "bwrap"} */ (backend),
    check: { ...config.checks.probe, run: ["node", "-e", script, "{source}"] },
  });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  assert.equal(result.stdout.trim(), "both blocked");
});
