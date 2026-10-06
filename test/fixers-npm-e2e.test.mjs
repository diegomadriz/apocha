// @ts-check
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { createFakeAdapter } from "../src/adapters/fake/index.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { git } from "../src/util/git.mjs";
import { fakeRuntimes, makeRepo, passReviewer, valueTask, writeValue } from "./helpers.mjs";

/** @param {string} cwd @param {boolean} writes */
function fixture(cwd, writes) {
  const repo = makeRepo({
    files: {
      ".gitignore": "node_modules/\n",
      [path.posix.join(cwd, "package.json")]: '{"private":true}\n',
      [path.posix.join(cwd, "package-lock.json")]: '{"lockfileVersion":3,"packages":{}}\n',
      "src/untouched.txt": "untouched\n",
      "formatter.mjs":
        `import { readFileSync, writeFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  writeFileSync(file, readFileSync(file, "utf8").trim() + "\\n");
}
` +
        (writes
          ? `
writeFileSync(process.env.NODE_PATH + "/snapshot-unreadable.txt", "dependency change");
writeFileSync(process.env.NODE_PATH + "/nested/node_modules/dep/value.txt", "nested change");
writeFileSync(new URL("./src/untouched.txt", import.meta.url), "outside change");
writeFileSync(process.env.HOME + "/cache.txt", "home change");
writeFileSync(process.env.TMPDIR + "/scratch.txt", "tmp change");
`
          : ""),
    },
    config: {
      version: 1,
      checks: { test: { run: ["node", "check.mjs"] } },
      fixers: {
        format: {
          run: ["node", path.posix.relative(cwd, "formatter.mjs"), "{files}"],
          cwd,
          dependencies: "npm",
        },
      },
      default_fixers: ["format"],
      sandbox: { mode: "none" },
    },
  });
  const dependencies = path.join(repo.root, cwd, "node_modules");
  mkdirSync(path.join(dependencies, "nested/node_modules/dep"), { recursive: true });
  writeFileSync(path.join(dependencies, "snapshot-unreadable.txt"), "dependency\n");
  writeFileSync(path.join(dependencies, "nested/node_modules/dep/value.txt"), "nested dependency\n");
  return repo;
}

/** @param {string} root */
async function run(root) {
  const fake = createFakeAdapter({
    handlers: {
      implementer: writeValue(" 2 "),
      reviewer: async (context) => {
        assert.match(context.bundle.diff, /\+2\n/);
        assert.doesNotMatch(context.bundle.diff, /outside change|dependency change/);
        await passReviewer(context);
      },
    },
  });
  const summary = await startRun({
    cwd: root,
    base: "main",
    batch: "npm-fixers",
    message: "Fix formatting with npm dependencies",
    runtimes: fakeRuntimes(),
    task: valueTask({ max_repair_attempts: 0 }),
    adapters: { implementer: fake, reviewer: fake },
  });
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  const store = new RunStore(root);
  const state = store.read(summary.run_id).state;
  return { summary, evidence: state.last_verification.fixers[0], events: store.events(summary.run_id) };
}

test("npm fixer skips dependencies but records outside changes and copies its fix", async () => {
  const repo = fixture("tools", true);
  const result = await run(repo.root);
  assert.equal(result.evidence.status, "pass");
  assert.deepEqual(result.evidence.changed, ["src/value.txt"]);
  assert.deepEqual(result.evidence.ignored_changes, ["src/untouched.txt"]);
  assert.deepEqual(result.events.find((event) => event.type === "fixer.finished").ignored_changes, [
    "src/untouched.txt",
  ]);
  assert.equal(git(repo.root, ["show", `${result.summary.promoted_head}:src/value.txt`]).stdout, "2\n");
  assert.equal(
    git(repo.root, ["show", `${result.summary.promoted_head}:src/untouched.txt`]).stdout,
    "untouched\n",
  );
  assert.equal(
    readFileSync(path.join(repo.root, "tools/node_modules/snapshot-unreadable.txt"), "utf8"),
    "dependency\n",
  );
});

test("npm fixer snapshots never read dependency files", async () => {
  const repo = fixture(".", false);
  const original = fs.readFileSync;
  let reads = 0;
  // A read guard also works as root, which can read chmod 000 files.
  fs.readFileSync = /** @type {typeof fs.readFileSync} */ (
    (file, ...args) => {
      if (String(file).endsWith(`${path.sep}node_modules${path.sep}snapshot-unreadable.txt`)) {
        reads++;
        throw new Error("dependency file must not be read");
      }
      return Reflect.apply(original, fs, [file, ...args]);
    }
  );
  syncBuiltinESMExports();
  try {
    const result = await run(repo.root);
    assert.equal(result.evidence.status, "pass");
    assert.deepEqual(result.evidence.changed, ["src/value.txt"]);
    assert.deepEqual(result.evidence.ignored_changes, []);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
});
