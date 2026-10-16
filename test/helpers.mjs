// @ts-check
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { createFakeAdapter as rawFakeAdapter } from "../src/adapters/fake/index.mjs";
import { normalizeRuntimeConfig } from "../src/config/runtime.mjs";
import { createCandidate } from "../src/git/candidate.mjs";
import { git } from "../src/util/git.mjs";

/** @param {Record<string, any>} bundle */
export function criteriaEvidence(bundle) {
  return (bundle.acceptance_criteria ?? []).map((_, index) => ({
    criterion: index + 1,
    evidence: bundle.checks.length
      ? [{ kind: "check", check_id: bundle.checks[0].id }]
      : [{ kind: "inspection", note: "Fixture has no runnable checks." }],
  }));
}

/** Scripted fixtures supply evidence unless explicitly provided.
 * @param {Parameters<typeof rawFakeAdapter>[0]} options
 */
export function createFakeAdapter(options = {}) {
  const implementer = options.handlers?.implementer;
  if (!implementer) return rawFakeAdapter(options);
  return rawFakeAdapter({
    ...options,
    handlers: {
      ...options.handlers,
      implementer: (context) =>
        implementer({
          ...context,
          call: (name, args) => {
            const output = /** @type {Record<string, any>} */ (args);
            return context.call(
              name,
              name === "submit_result" && output.status !== "blocked"
                ? { criteria_evidence: criteriaEvidence(context.bundle), ...output }
                : args,
            );
          },
        }),
    },
  });
}

/** Create a fixture directory and register cleanup even if setup fails. @param {string} kind */
export function testTempDir(kind) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `apocha-${kind}-`)));
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Choose a temp directory for socket paths below 100 bytes (macOS sun_path is 104 bytes).
 * @param {string} socketName The longest socket filename that will be used in this directory.
 */
export function socketTempDir(socketName) {
  for (const temporary of [os.tmpdir(), "/tmp"]) {
    const parent = realpathSync(temporary);
    // mkdtemp appends six characters; count UTF-8 bytes, including the filename.
    const prefix = path.join(parent, "apocha-ipc-");
    if (Buffer.byteLength(path.join(`${prefix}XXXXXX`, socketName)) < 100) return parent;
  }
  throw new Error("Unix socket fixture path exceeds the 100-byte safety limit");
}

/** Create a short socket fixture directory and register cleanup. @param {string} socketName */
export function testSocketDir(socketName) {
  const root = mkdtempSync(path.join(socketTempDir(socketName), "apocha-ipc-"));
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
 * Create a throwaway Git repository with a committed apocha.config.json.
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
    "apocha.config.json": `${JSON.stringify(config, null, 2)}\n`,
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
    ...(bundle.judge_input_changes?.length
      ? {
          judge_input_verdicts: bundle.judge_input_changes.map((entry) => ({
            path: entry.path,
            verdict: "justified",
            reason: "The fixture change is needed and preserves check coverage.",
          })),
        }
      : {}),
    candidate_digest: bundle.candidate.candidate_digest,
  });
};

/** Implementer handler that writes `value` into src/value.txt. */
export const writeValue =
  (value) =>
  async ({ bundle, call }) => {
    const current = await call("read_files", { paths: ["src/value.txt"] });
    await call("apply_patch", {
      edits: [{ path: "src/value.txt", old_text: current.files[0].content, new_text: `${value}\n` }],
    });
    await call("submit_result", {
      summary: `set value to ${value}`,
      criteria_evidence: criteriaEvidence(bundle),
    });
  };
