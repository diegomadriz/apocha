// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRun } from "../src/core/run.mjs";
import { landBranch } from "../src/git/land.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { verifyRange } from "../src/git/verify-range.mjs";
import { git, gitText } from "../src/util/git.mjs";
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

/** @param {string} root @param {string[]} args @param {Record<string, string>} [env] */
function cli(root, args, env = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

/**
 * @param {string} root
 * @param {string} batch
 * @param {number} value
 * @param {{ key?: string, signers?: string }} [options]
 */
async function run(root, batch, value, options = {}) {
  const implementer = options.signers
    ? async ({ call }) => {
        const current = await call("read_files", { paths: ["src/value.txt", ".apocha/allowed_signers"] });
        await call("apply_patch", {
          edits: [
            { path: "src/value.txt", old_text: current.files[0].content, new_text: `${value}\n` },
            {
              path: ".apocha/allowed_signers",
              old_text: current.files[1].content,
              new_text: options.signers,
            },
          ],
        });
        await call("submit_result", { summary: "change value and signers" });
      }
    : writeValue(value);
  const fake = createFakeAdapter({ handlers: { implementer, reviewer: passReviewer } });
  const result = await startRun({
    cwd: root,
    base: "main",
    batch,
    message: `Set value to ${value}`,
    task: valueTask({
      checks: ["ok"],
      allowed_paths: options.signers ? ["src/", ".apocha/allowed_signers"] : ["src/"],
    }),
    runtimes: fakeRuntimes(options.key ? { signing: { key: options.key, principal } } : {}),
    adapters: { implementer: fake, reviewer: fake },
    allowGovernanceEdits: Boolean(options.signers),
    governanceReason: options.signers ? "test base trust" : undefined,
  });
  assert.equal(result.outcome, "PASSED", result.reason ?? "");
  assert.ok(result.promoted_head);
  return result.promoted_head;
}

/** @param {string} name */
function keyPair(name) {
  const key = path.join(testTempDir(name), "key");
  const generated = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  return { key, line: `${principal} ${readFileSync(`${key}.pub`, "utf8")}` };
}

test("verify-range checks two controller commits across a land and writes a summary", async () => {
  const repo = makeRepo();
  try {
    const base = gitText(repo.root, ["rev-parse", "main"]);
    const first = await run(repo.root, "first", 2);
    landBranch({ repositoryRoot: repo.root, notesRef: "refs/notes/apocha", source: first, target: "main" });
    const second = await run(repo.root, "second", 3);
    const result = verifyRange({ repositoryRoot: repo.root, base, head: second });
    assert.equal(result.valid, true);
    assert.deepEqual(
      result.commits.map((check) => check.commit),
      [first, second],
    );
    assert.ok(result.commits.every((check) => check.valid && check.signature.status === "unsigned"));
    const summary = path.join(testTempDir("summary"), "summary.md");
    const printed = cli(repo.root, ["verify-range", `${base}..${second}`, "--json"], {
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), result);
    const markdown = readFileSync(summary, "utf8");
    assert.match(markdown, /\| Commit \| Result \| Signature \|/);
    assert.ok(markdown.includes(first) && markdown.includes(second));
    const signed = cli(repo.root, ["verify-range", `${base}..${second}`, "--require-signed"]);
    assert.notEqual(signed.status, 0);
    assert.ok(signed.stdout.includes(`First failing commit: ${first}`));
    assert.match(signed.stdout, /receipt signature: unsigned/);
    const signedJson = cli(repo.root, ["verify-range", `${base}..${second}`, "--require-signed", "--json"]);
    assert.notEqual(signedJson.status, 0);
    assert.equal(JSON.parse(signedJson.stdout).commits[0].code, "unsigned_receipt");
  } finally {
    repo.cleanup();
  }
});

test("verify-range reports every commit and names the first missing receipt through the CLI", async () => {
  const repo = makeRepo();
  try {
    const base = gitText(repo.root, ["rev-parse", "main"]);
    writeFileSync(path.join(repo.root, "src/manual.txt"), "manual\n");
    git(repo.root, ["add", "src/manual.txt"]);
    git(repo.root, ["commit", "-qm", "Manual change"]);
    const manual = gitText(repo.root, ["rev-parse", "HEAD"]);
    const head = await run(repo.root, "after-manual", 2);
    const result = verifyRange({ repositoryRoot: repo.root, base, head });
    assert.equal(result.valid, false);
    assert.equal(result.first_failing_commit, manual);
    assert.deepEqual(
      result.commits.map((check) => check.commit),
      [manual, head],
    );
    assert.equal(result.commits[0].reason, "missing receipt");
    assert.equal(result.commits[1].valid, true);
    const printed = cli(repo.root, ["verify-range", `${base}..${head}`]);
    assert.notEqual(printed.status, 0);
    assert.ok(printed.stdout.includes(`First failing commit: ${manual}`));
    assert.match(printed.stdout, /missing receipt/);
    const signed = cli(repo.root, ["verify-range", `${base}..${head}`, "--require-signed"]);
    assert.notEqual(signed.status, 0);
    assert.ok(signed.stdout.includes(`${manual} missing receipt`));
    const signedJson = cli(repo.root, ["verify-range", `${base}..${head}`, "--require-signed", "--json"]);
    assert.notEqual(signedJson.status, 0);
    assert.equal(JSON.parse(signedJson.stdout).commits[0].code, "missing_receipt");
    assert.equal(JSON.parse(signedJson.stdout).commits[1].code, "unsigned_receipt");
  } finally {
    repo.cleanup();
  }
});

for (const scenario of ["signed", "head-only", "config-required"]) {
  test(`verify-range signature policy uses base: ${scenario}`, async () => {
    const trusted = keyPair("range-trusted");
    const other = keyPair("range-other");
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
      const base = gitText(repo.root, ["rev-parse", "main"]);
      const head = await run(repo.root, scenario, 2, {
        key: scenario === "config-required" ? undefined : scenario === "head-only" ? other.key : trusted.key,
        signers: scenario === "head-only" ? trusted.line + other.line : undefined,
      });
      const printed = cli(repo.root, [
        "verify-range",
        `${base}..${head}`,
        "--json",
        ...(scenario === "config-required" ? [] : ["--require-signed"]),
      ]);
      const result = JSON.parse(printed.stdout);
      assert.equal(result.require_signed, true);
      if (scenario === "signed") {
        assert.equal(printed.status, 0, printed.stderr);
        assert.equal(result.valid, true);
        assert.equal(result.commits[0].signature.status, "valid");
      } else {
        assert.notEqual(printed.status, 0);
        assert.equal(result.first_failing_commit, head);
        assert.equal(
          result.commits[0].signature.status,
          scenario === "head-only" ? "unknown_signer" : "unsigned",
        );
        if (scenario === "head-only")
          assert.equal(verifyReceipt(repo.root, "refs/notes/apocha", head, head).signature.status, "valid");
      }
    } finally {
      repo.cleanup();
    }
  });
}

test("root action uses block YAML and runs only receipt verification", () => {
  const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(action, /^name: Apocha receipts$/m);
  assert.match(action, /^inputs:$/m);
  assert.match(action, /^runs:\n {2}using: composite\n {2}steps:$/m);
  for (const [input, value] of [
    ["require-signed", "'false'"],
    ["node-version", "'24'"],
    ["base", `'\${{ github.event.pull_request.base.sha }}'`],
    ["head", `'\${{ github.event.pull_request.head.sha }}'`],
  ]) {
    const lines = action.split("\n");
    const index = lines.indexOf(`  ${input}:`);
    assert.ok(index >= 0);
    assert.equal(lines[index + 2], `    default: ${value}`);
  }
  assert.match(action, /^ {4}- uses: actions\/setup-node@v7$/m);
  assert.match(action, /^ {4}- name: Fetch history and receipt notes\n {6}shell: bash$/m);
  assert.match(action, /^ {8}git fetch origin "\+refs\/notes\/\*:refs\/notes\/\*"$/m);
  assert.match(action, /^ {10}git fetch --unshallow origin$/m);
  assert.match(action, /^ {6}working-directory: \$\{\{ github.action_path \}\}$/m);
  assert.match(action, /^ {8}npm ci --omit=dev --ignore-scripts$/m);
  assert.match(action, /^ {4}- name: Verify receipts\n {6}shell: bash$/m);
  assert.match(
    action,
    /^ {8}node "\$APOCHA_ACTION_PATH\/bin\/apocha\.mjs" verify-range "\$APOCHA_BASE\.\.\$APOCHA_HEAD" "\$\{args\[@\]\}"$/m,
  );
  assert.doesNotMatch(
    action,
    /git push|apocha\.mjs" (?:run|integrate|resume)|OPENAI_API_KEY|ANTHROPIC_API_KEY/,
  );
});
