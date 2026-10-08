// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "../src/config/project.mjs";
import { startRun } from "../src/core/run.mjs";
import { landBranch } from "../src/git/land.mjs";
import { readReceipt, verifyReceipt } from "../src/git/receipts.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testTempDir,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const principal = "operator@example.invalid";
const notes = "refs/notes/apocha";

/** @param {string} name */
function keyPair(name) {
  const key = path.join(testTempDir(name), "key");
  const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { key, line: `${principal} ${readFileSync(`${key}.pub`, "utf8")}` };
}

/** @param {string} root @param {string[]} args */
function cli(root, args) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)), ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

/** @param {string} root @param {string} commit @param {any} receipt */
function replaceNote(root, commit, receipt) {
  git(root, ["notes", `--ref=${notes}`, "add", "-f", "-F", "-", commit], {
    input: JSON.stringify(receipt),
  });
}

/** @param {string} root @param {string | undefined} key @param {string | undefined} [sourceSigners] */
async function run(root, key, sourceSigners) {
  const implementer = sourceSigners
    ? async ({ call }) => {
        await call("read_files", { paths: ["src/value.txt", ".apocha/allowed_signers"] });
        await call("apply_patch", {
          edits: [
            { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
            {
              path: ".apocha/allowed_signers",
              old_text: readFileSync(path.join(root, ".apocha/allowed_signers"), "utf8"),
              new_text: sourceSigners,
            },
          ],
        });
        await call("submit_result", { summary: "change value and source signers" });
      }
    : writeValue(2);
  const fake = createFakeAdapter({ handlers: { implementer, reviewer: passReviewer } });
  const result = await startRun({
    cwd: root,
    base: "main",
    batch: "signed",
    message: "Set value",
    task: valueTask({
      checks: ["ok"],
      allowed_paths: sourceSigners ? ["src/", ".apocha/allowed_signers"] : ["src/"],
    }),
    runtimes: fakeRuntimes(key ? { signing: { key, principal } } : {}),
    adapters: { implementer: fake, reviewer: fake },
    allowGovernanceEdits: Boolean(sourceSigners),
    governanceReason: sourceSigners ? "exercise source-only trust change" : undefined,
  });
  assert.equal(result.outcome, "PASSED", result.reason ?? "");
  assert.equal(typeof result.promoted_head, "string");
  return /** @type {string} */ (result.promoted_head);
}

for (const scenario of ["sign", "land", "forgery", "unknown", "tamper", "source-only", "config-required"]) {
  test(`SSH receipts through controller: ${scenario}`, async () => {
    const trusted = keyPair("trusted");
    const other = keyPair("other");
    const repo = makeRepo({
      files: { ".apocha/allowed_signers": trusted.line },
      ...(scenario === "config-required"
        ? {
            config: {
              version: 1,
              checks: { ok: { run: ["node", "-e", "process.exit(0)"] } },
              sandbox: { mode: "none" },
              receipts: { require_signed: true },
            },
          }
        : {}),
    });
    try {
      const target = resolveCommit(repo.root, "main");
      assert.ok(target);
      const key = ["forgery", "config-required"].includes(scenario)
        ? undefined
        : ["unknown", "source-only"].includes(scenario)
          ? other.key
          : trusted.key;
      const commit = await run(
        repo.root,
        key,
        scenario === "source-only" ? trusted.line + other.line : undefined,
      );
      const verify = () => verifyReceipt(repo.root, notes, commit, target);
      const receipt = readReceipt(repo.root, notes, commit);
      const land = () =>
        landBranch({
          repositoryRoot: repo.root,
          notesRef: notes,
          source: commit,
          target: "main",
          requireSigned: true,
        });
      assert.ok(loadProjectConfig(repo.root).paths.governance.includes(".apocha/allowed_signers"));
      if (scenario === "sign") {
        assert.equal(receipt.signature.format, "ssh");
        assert.equal(verify().signature.status, "valid");
        assert.equal(verify().valid, true);
        const printed = cli(repo.root, ["receipt", commit]);
        assert.equal(printed.status, 0, printed.stderr);
        assert.equal(JSON.parse(printed.stdout).signature.status, "valid");
        const runtimes = path.join(testTempDir("runtime"), "runtimes.json");
        writeFileSync(
          runtimes,
          JSON.stringify({
            version: 1,
            roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
            signing: { key, principal },
          }),
        );
        const doctor = cli(repo.root, ["doctor", "--json", "--runtimes", runtimes]);
        const reports = JSON.parse(doctor.stdout);
        assert.equal(reports.find((r) => r.name === "signing key allowed").ok, true);
        assert.match(reports.find((r) => r.name === "receipt signing").detail, /configured/);
        assert.equal(reports.find((r) => r.name === "signed receipts required").detail, "no");
      } else if (scenario === "land") {
        const result = cli(repo.root, ["land", commit, "--target", "main", "--require-signed"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(resolveCommit(repo.root, "main"), commit);
      } else if (scenario === "forgery") {
        // Hand-write a schema-valid note with the correct digest but fabricated provenance.
        receipt.run_id = "fabricated-run";
        receipt.task_id = "fabricated-task";
        replaceNote(repo.root, commit, receipt);
        assert.equal(verify().valid, true);
        assert.equal(verify().signature.status, "unsigned");
        assert.throws(land, (e) => e.code === "unsigned_receipt" && e.message.includes(commit));
        const refused = cli(repo.root, ["land", commit, "--target", "main", "--require-signed"]);
        assert.notEqual(refused.status, 0);
        assert.ok(refused.stderr.includes(commit));
        assert.match(refused.stderr, /receipt signature: unsigned/);
        git(repo.root, ["notes", `--ref=${notes}`, "remove", commit]);
        const missing = cli(repo.root, ["land", commit, "--target", "main", "--require-signed"]);
        assert.notEqual(missing.status, 0);
        assert.ok(missing.stderr.includes(commit));
        assert.doesNotMatch(missing.stderr, /receipt signature: unsigned/);
        assert.match(missing.stderr, /missing receipt/);
        assert.throws(land, (e) => e.code === "missing_receipt");
        replaceNote(repo.root, commit, receipt);
        const accepted = cli(repo.root, ["land", commit, "--target", "main"]);
        assert.equal(accepted.status, 0, accepted.stderr);
      } else if (scenario === "config-required") {
        const result = cli(repo.root, ["land", commit, "--target", "main"]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unsigned/);
        assert.equal(resolveCommit(repo.root, "main"), target);
      } else if (scenario === "tamper") {
        assert.equal(verify().signature.status, "valid");
        receipt.task_id = "tampered-task";
        replaceNote(repo.root, commit, receipt);
        assert.equal(verify().signature.status, "invalid");
        assert.equal(verify().valid, false);
        assert.throws(land, (e) => e.code === "bad_signature");
      } else {
        if (scenario === "source-only")
          assert.equal(verifyReceipt(repo.root, notes, commit, commit).signature.status, "valid");
        assert.equal(verify().signature.status, "unknown_signer");
        assert.throws(land, (e) => e.code === "bad_signature" && e.message.includes(commit));
        assert.equal(resolveCommit(repo.root, "main"), target);
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("custom allowed signers support signed landing and status", async () => {
  const trusted = keyPair("custom-signers");
  const repo = makeRepo({
    files: { ".apocha/signers": trusted.line },
    config: {
      version: 1,
      checks: { ok: { run: ["node", "-e", "process.exit(0)"] } },
      sandbox: { mode: "none" },
      receipts: { allowed_signers: ".apocha/signers" },
    },
  });
  try {
    const commit = await run(repo.root, trusted.key);
    const printed = cli(repo.root, ["status", "--target", "main", "--json"]);
    assert.equal(printed.status, 0, printed.stderr);
    const batch = JSON.parse(printed.stdout).batches.find((entry) => entry.tip === commit);
    assert.ok(batch);
    assert.equal(batch.state, "ready");
    assert.equal(batch.receipted, true);
    assert.equal(batch.receipts[0].valid, true);
    assert.equal(batch.receipts[0].signature.status, "valid");
    const landed = cli(repo.root, [
      "land",
      "apocha/batch/signed",
      "--target",
      "main",
      "--require-signed",
      "--keep-batch",
    ]);
    assert.equal(landed.status, 0, landed.stderr);
    assert.equal(resolveCommit(repo.root, "main"), commit);
    const status = cli(repo.root, ["status", "--target", "main", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).batches.find((entry) => entry.tip === commit).state, "landed");
    const receipt = cli(repo.root, ["receipt", commit]);
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(JSON.parse(receipt.stdout).signature.status, "valid");
  } finally {
    repo.cleanup();
  }
});
