// @ts-check
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { normalizeRuntimeConfig } from "../src/config/runtime.mjs";
import { createCandidate } from "../src/git/candidate.mjs";
import { git } from "../src/util/git.mjs";

/** Create a fixture directory and register cleanup even if setup fails. @param {string} kind */
export function testTempDir(kind) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `panagent-${kind}-`)));
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** @param {string} repositoryRoot @param {string} base */
export function testCandidate(repositoryRoot, base) {
  const candidate = createCandidate(repositoryRoot, base);
  after(() => candidate.cleanup());
  return candidate;
}

/**
 * Create a throwaway Git repository with a committed panagent.config.json.
 * @param {{ files?: Record<string, string>, config?: Record<string, any> }} [options]
 */
export function makeRepo(options = {}) {
  const root = testTempDir("test-repo");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  const config = options.config ?? {
    version: 1,
    checks: {
      ok: { run: ["node", "-e", "process.exit(0)"], cwd: "." },
      test: { run: ["node", "check.mjs"], cwd: "." },
    },
    default_checks: ["test"],
    paths: { governance: ["AGENTS.md"], forbidden: ["private/"] },
    sandbox: { mode: "none" },
  };
  const files = {
    "README.md": "# fixture\n",
    "src/value.txt": "1\n",
    "check.mjs":
      'import { readFileSync } from "node:fs";\nconst v = readFileSync("src/value.txt", "utf8").trim();\nif (v !== "2") { console.error("src/value.txt:1 expected 2, got " + v); process.exit(1); }\n',
    "private/secret.txt": "do not read\n",
    "panagent.config.json": `${JSON.stringify(config, null, 2)}\n`,
    ...(options.files ?? {}),
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture"]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A normalized runtime config for the fake adapter. */
export function fakeRuntimes(overrides = {}) {
  return normalizeRuntimeConfig(
    {
      version: 1,
      roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
      budgets: { timeout_ms: 60000, max_tool_calls: 50 },
      ...overrides,
    },
    "test",
  );
}

/** A basic task that asks for src/value.txt to become 2. */
export function valueTask(overrides = {}) {
  return {
    task_id: "set-value",
    description: "Set src/value.txt to 2.",
    acceptance_criteria: ["src/value.txt contains 2"],
    allowed_paths: ["src/"],
    checks: ["test"],
    max_repair_attempts: 1,
    ...overrides,
  };
}

/** Reviewer handler that passes, echoing the digest from the bundle. */
export const passReviewer = async ({ bundle, call }) => {
  await call("submit_result", {
    decision: "PASS",
    findings: [],
    candidate_digest: bundle.candidate.candidate_digest,
  });
};

/** Implementer handler that writes `value` into src/value.txt. */
export const writeValue =
  (value) =>
  async ({ call }) => {
    const current = await call("read_files", { paths: ["src/value.txt"] });
    await call("apply_patch", {
      edits: [{ path: "src/value.txt", old_text: current.files[0].content, new_text: `${value}\n` }],
    });
    await call("submit_result", { summary: `set value to ${value}` });
  };
