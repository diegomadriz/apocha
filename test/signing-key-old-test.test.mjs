// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { detectBackend } from "../src/sandbox/index.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  testTempDir,
  valueTask,
} from "./helpers.mjs";

test("every source runCheck call forwards signingKey", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  let calls = 0;
  /** @param {string} dir */
  function inspect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith(".mjs")) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?<!function )\brunCheck\(\{([\s\S]*?)^\s*\}\)/gm)) {
          calls++;
          assert.match(match[1], /\bsigningKey\s*:/, path.relative(root, file));
        }
      }
    }
  }
  inspect(root);
  assert.ok(calls > 0, "must inspect actual runCheck calls");
});

const backend = detectBackend();
test("controller denies the runtime signing key to old tests on the candidate", {
  skip: !backend && "no sandbox backend available",
}, async () => {
  // This key is outside the repository, credential directories and default deny paths.
  const key = path.join(testTempDir("old-test-signing"), "receipt");
  const generated = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key], {
    encoding: "utf8",
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(readFileSync(key, "utf8"), /PRIVATE KEY/);
  const testPath = "test/value.test.mjs";
  const oldSource = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const observed = readFileSync("src/value.txt", "utf8").trim();
assert.ok(observed);
if (observed === "2") {
  let readable = false;
  try {
    readable = readFileSync(${JSON.stringify(key)}, "utf8").includes("PRIVATE KEY");
  } catch (error) {
    assert.ok(["EACCES", "EPERM"].includes(error.code), error.message);
  }
  // Exit status records whether the key was readable, including bubblewrap's empty-file mask.
  assert.equal(readable, false, "old test on candidate must not read the signing key");
}
`;
  const nextSource = oldSource.replaceAll("observed", "actual");
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { tests: { run: ["node", testPath] } },
      tests: {
        paths: ["test/"],
        run_files: { run: ["node", "{files}"] },
      },
      sandbox: { mode: "required" },
    },
    files: { [testPath]: oldSource },
  });
  try {
    const fake = createFakeAdapter({
      handlers: {
        implementer: async ({ call }) => {
          await call("apply_patch", {
            edits: [
              { path: "src/value.txt", old_text: "1\n", new_text: "2\n" },
              { path: testPath, old_text: oldSource, new_text: nextSource },
            ],
          });
          await call("submit_result", { summary: "Rename the test local and update the value" });
        },
        reviewer: passReviewer,
      },
    });
    const summary = await startRun({
      cwd: repo.root,
      base: "main",
      batch: "old-test-signing",
      message: "Protect signing key in old-test evidence",
      runtimes: fakeRuntimes({ signing: { key, principal: "operator@example.invalid" } }),
      task: valueTask({
        allowed_paths: ["src/", "test/"],
        checks: ["tests"],
        test_edits: "justified",
        test_changes: [{ path: testPath, kind: "refactor", reason: "Rename the local variable" }],
        max_repair_attempts: 0,
      }),
      adapters: { implementer: fake, reviewer: fake },
    });
    const store = new RunStore(repo.root);
    const verification = store.read(summary.run_id).state.last_verification;
    assert.equal(verification.effective_policy, "justified");
    assert.equal(verification.test_changes.length, 1);
    const evidence = verification.test_changes[0];
    assert.equal(evidence.path, testPath);
    assert.equal(evidence.change, "modified");
    assert.equal(evidence.new_on_base, "passes_on_base");
    assert.equal(evidence.old_on_candidate, "old_passes_on_candidate");
    assert.equal(evidence.verdict, "refactor");
    assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
    assert.equal(
      store.events(summary.run_id).find((event) => event.type === "test-change.finished").old_on_candidate,
      "old_passes_on_candidate",
    );
  } finally {
    repo.cleanup();
  }
});
