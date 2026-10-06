// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { validateTask } from "../src/config/task.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { verifyReceipt } from "../src/git/receipts.mjs";
import { git } from "../src/util/git.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask } from "./helpers.mjs";

const formatter = `import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  const input = readFileSync(file, "utf8");
  writeFileSync(file, input.trim() + "\\n");
}
if (process.env.OUTSIDE) {
  writeFileSync("README.md", "tampered");
  writeFileSync("src/untouched.txt", "tampered");
  writeFileSync("src/created.txt", "created");
  writeFileSync("apocha.config.json", "{}");
  unlinkSync("src/deleted.txt");
}
if (process.env.FAIL) process.exit(1);
if (process.env.TIMEOUT) setTimeout(() => {}, 10000);
`;

function fixture(env = {}, acceptBad = false) {
  return makeRepo({
    files: {
      "formatter.mjs": formatter,
      "src/untouched.txt": "untouched\n",
      "src/deleted.txt": "deleted\n",
      "check.mjs": `import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const value = readFileSync("src/value.txt", "utf8");
assert.ok(${acceptBad ? 'value === " 2 \\n"' : "/^[23]\\n$/.test(value)"});
assert.equal(readFileSync("README.md", "utf8"), "# fixture\\n");
assert.equal(readFileSync("src/untouched.txt", "utf8"), "untouched\\n");
assert.equal(readFileSync("src/deleted.txt", "utf8"), "deleted\\n");
assert.equal(existsSync("src/created.txt"), false);
`,
    },
    config: {
      version: 1,
      checks: { test: { run: ["node", "check.mjs"] } },
      fixers: { format: { run: ["node", "formatter.mjs", "{files}"], env, timeout_ms: 1000 } },
      default_fixers: ["format"],
      sandbox: { mode: "none" },
    },
  });
}

/** @param {string} root @param {{ disabled?: boolean, input?: string, batch?: string, fixed?: boolean }} [options] */
async function run(root, options = {}) {
  let diff = "";
  let invocations = 0;
  const fake = createFakeAdapter({
    handlers: {
      implementer: async ({ call, bundle }) => {
        invocations++;
        assert.deepEqual(
          bundle.fixers.map((fixer) => fixer.id),
          options.disabled ? [] : ["format"],
        );
        if (!options.disabled) assert.match(bundle.fixers[0].automatic, /before checks/);
        await call("read_files", { paths: ["src/value.txt"] });
        await call("apply_patch", {
          edits: [{ path: "src/value.txt", old_text: "1\n", new_text: options.input ?? " 2 \n" }],
        });
        await call("submit_result", { summary: "Write an unformatted value" });
      },
      reviewer: async (context) => {
        diff = context.bundle.diff;
        if (options.fixed !== false) {
          assert.match(diff, options.input?.trim() === "3" ? /\+3\n/ : /\+2\n/);
          assert.doesNotMatch(diff, /\+ 2 /);
        } else assert.match(diff, /\+ 2 \n/);
        await passReviewer(context);
      },
    },
  });
  const summary = await startRun({
    cwd: root,
    base: "main",
    batch: options.batch ?? "fixers",
    message: "Fix formatting",
    runtimes: fakeRuntimes(),
    task: valueTask({ max_repair_attempts: 0, ...(options.disabled ? { fixers: [] } : {}) }),
    adapters: { implementer: fake, reviewer: fake },
  });
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.equal(invocations, 1);
  const store = new RunStore(root);
  const state = store.read(summary.run_id).state;
  assert.equal(state.attempt, 1);
  assert.equal(state.counters.repairs ?? 0, 0);
  const receipt = verifyReceipt(root, "refs/notes/apocha", summary.promoted_head);
  assert.equal(receipt.valid, true, receipt.reason ?? "");
  const verification = JSON.parse(
    readFileSync(path.join(store.dir(summary.run_id), "verification-01.json"), "utf8"),
  );
  assert.deepEqual(verification.fixers, state.last_verification.fixers);
  return { summary, state, receipt: receipt.receipt, events: store.events(summary.run_id), diff };
}

test("automatic formatter passes first verification and is recorded in receipt", async () => {
  const repo = fixture();
  const result = await run(repo.root);
  assert.deepEqual(result.receipt.fixers, [
    {
      id: "format",
      definition_digest: result.state.last_verification.fixers[0].definition_digest,
      status: "pass",
      changed: ["src/value.txt"],
    },
  ]);
  assert.equal(result.events.filter((event) => event.type === "fixer.finished").length, 1);
  assert.equal(git(repo.root, ["show", `${result.summary.promoted_head}:src/value.txt`]).stdout, "2\n");
});

test("fixer writes outside argument files are ignored and recorded", async () => {
  const repo = fixture({ OUTSIDE: "1" });
  const result = await run(repo.root);
  const ignored = [
    "README.md",
    "apocha.config.json",
    "src/created.txt",
    "src/deleted.txt",
    "src/untouched.txt",
  ];
  assert.deepEqual(result.state.last_verification.fixers[0].ignored_changes, ignored);
  assert.deepEqual(result.events.find((event) => event.type === "fixer.finished").ignored_changes, ignored);
  assert.deepEqual(result.state.last_verification.changed_files, ["src/value.txt"]);
  assert.equal(git(repo.root, ["show", `${result.summary.promoted_head}:README.md`]).stdout, "# fixture\n");
});

for (const env of [{ FAIL: "1" }, { TIMEOUT: "1" }]) {
  test(`unsuccessful fixer copies nothing and continues to catalog checks: ${Object.keys(env)[0]}`, async () => {
    const repo = fixture(env, true);
    const result = await run(repo.root, { fixed: false });
    assert.equal(result.receipt.fixers[0].status, env.FAIL ? "fail" : "infra_error");
    assert.deepEqual(result.receipt.fixers[0].changed, []);
    assert.equal(result.summary.checks.find((check) => check.id === "test").status, "pass");
    assert.equal(git(repo.root, ["show", `${result.summary.promoted_head}:src/value.txt`]).stdout, " 2 \n");
  });
}

test("task fixers empty list disables default formatter", async () => {
  const repo = fixture({}, true);
  const result = await run(repo.root, { disabled: true, fixed: false });
  assert.deepEqual(result.receipt.fixers, []);
  assert.equal(
    result.events.some((event) => event.type === "fixer.finished"),
    false,
  );
});

test("fixed content changes candidate identity and is in the reviewer diff", async () => {
  const repo = fixture();
  const first = await run(repo.root, { batch: "first" });
  const second = await run(repo.root, { batch: "second", input: " 3 \n" });
  assert.equal(first.receipt.base_commit, second.receipt.base_commit);
  assert.notEqual(first.receipt.candidate_digest, second.receipt.candidate_digest);
  assert.match(first.diff, /\+2\n/);
  assert.match(second.diff, /\+3\n/);
  assert.equal(second.receipt.candidate_digest, second.state.last_review.candidate_digest);
});

test("fixer catalogs validate selection, commands, and config identity", () => {
  const raw = {
    version: 1,
    checks: {},
    fixers: { format: { run: ["node", "{files}"] } },
    default_fixers: ["format"],
  };
  const config = normalizeProjectConfig(raw, "/fixture");
  assert.deepEqual(validateTask(valueTask({ checks: [] }), config).fixers, ["format"]);
  assert.deepEqual(validateTask(valueTask({ checks: [], fixers: [] }), config).fixers, []);
  assert.throws(() => validateTask(valueTask({ checks: [], fixers: ["missing"] }), config), /unknown fixer/);
  assert.throws(() => validateTask(valueTask({ checks: [], fixers: [{ run: ["node"] }] }), config));
  assert.throws(
    () => normalizeProjectConfig({ ...raw, default_fixers: ["missing"] }, "/fixture"),
    /unknown fixer/,
  );
  for (const run of [
    ["node", "{files}", "{files}"],
    ["node", "prefix{files}"],
  ])
    assert.throws(() => normalizeProjectConfig({ ...raw, fixers: { format: { run } } }, "/fixture"));
  assert.notEqual(
    config.digest,
    normalizeProjectConfig({ ...raw, fixers: { format: { run: ["other"] } } }, "/fixture").digest,
  );
});
