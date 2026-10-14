// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFINITIONS } from "../src/analytics/compute.mjs";
import { taskDigest } from "../src/config/task.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { git, resolveCommit } from "../src/util/git.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url));

/** @param {string} cwd @param {string[]} args */
function cli(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("doctor reports browser checks alongside unsandboxed checks", () => {
  const repo = makeRepo({
    config: {
      version: 1,
      checks: {
        browser: { run: ["node"], browser: true },
        ordinary: { run: ["node"] },
        "opted-out": { run: ["node"], unsandboxed: true },
      },
    },
  });
  try {
    const rows = JSON.parse(cli(repo.root, ["doctor", "--json"]).stdout);
    const browser = rows.find((row) => row.name === "browser checks");
    assert.equal(browser.ok, true);
    assert.equal(browser.detail, "browser (Seatbelt allows org.chromium Mach services)");
    assert.equal(rows.find((row) => row.name === "unsandboxed checks").detail, "opted-out");
    assert.match(cli(repo.root, ["doctor"]).stdout, /browser.*Seatbelt allows org.chromium Mach services/);
  } finally {
    repo.cleanup();
  }
});

test("help, version, and unknown commands", () => {
  assert.match(cli(os.tmpdir(), ["--help"]).stdout, /Usage: apocha <command>/);
  assert.match(cli(os.tmpdir(), ["version"]).stdout, /^\d+\.\d+\.\d+/);
  const unknown = cli(os.tmpdir(), ["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
});

test("analytics reports recorded runs in text, JSON and Markdown with filters", () => {
  const repo = makeRepo();
  try {
    const store = new RunStore(repo.root);
    for (const [index, workflow] of ["code-delivery", "integrate", "code-delivery"].entries()) {
      const id = `analytics-20260101T000000Z-000${index}`;
      store.create(id, {
        task_id: `task-${index}`,
        workflow,
        created_at: `2026-01-0${index + 1}T23:59:59Z`,
      });
      store.update(id, { outcome: index === 2 ? "FAILED" : "PASSED" });
    }
    const text = cli(repo.root, ["analytics"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /window: runs=3/);
    assert.match(text.stdout, /PASSED=2/);
    const json = cli(repo.root, ["analytics", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.window.runs, 3);
    assert.deepEqual(result.definitions, DEFINITIONS);
    const md = cli(repo.root, ["analytics", "--format", "md"]);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /## Window/);
    assert.match(md.stdout, /## Definitions/);
    assert.match(cli(repo.root, ["analytics", "--format", "text"]).stdout, /window: runs=3/);
    const filtered = cli(repo.root, [
      "analytics",
      "--json",
      "--since",
      "2026-01-02",
      "--until",
      "2026-01-03",
      "--workflow",
      "code-delivery",
    ]);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.equal(JSON.parse(filtered.stdout).window.runs, 1);
    assert.deepEqual(JSON.parse(filtered.stdout).outcomes.by_outcome, { FAILED: 1 });
    assert.match(cli(repo.root, ["help"]).stdout, /analytics.*--since/);
    for (const args of [
      ["--since", "bad"],
      ["--since", "2026-02-30"],
      ["--until", "2026-1-01"],
      ["--until", "2026-13-01"],
      ["--format", "html"],
    ]) {
      const bad = cli(repo.root, ["analytics", ...args]);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /usage:/);
    }
  } finally {
    repo.cleanup();
  }
});

test("init writes a starter config that validates, and refuses to overwrite", () => {
  const root = testTempDir("cli");
  git(root, ["init", "-q"]);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", lint: "x" } }),
  );
  const first = cli(root, ["init"]);
  assert.equal(first.code, 0, first.stderr);
  const config = JSON.parse(readFileSync(path.join(root, "apocha.config.json"), "utf8"));
  assert.deepEqual(Object.keys(config.checks).sort(), ["lint", "test"]);
  assert.equal(config.sandbox.mode, "required");
  assert.equal(cli(root, ["init"]).code, 2);
});

test("repository runtimes require trust and explicit runtimes always win", () => {
  const repo = makeRepo();
  const xdg = testTempDir("xdg");
  try {
    const repoConfig = path.join(repo.root, ".apocha", "runtimes.json");
    const userConfig = path.join(xdg, "apocha", "runtimes.json");
    const explicitConfig = path.join(repo.root, "explicit-runtimes.json");
    const raw = JSON.stringify({
      version: 1,
      roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
    });
    for (const file of [repoConfig, userConfig, explicitConfig]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, raw);
    }
    const env = { XDG_CONFIG_HOME: xdg, APOCHA_TRUST_REPO_RUNTIMES: "" };
    const source = (result) => JSON.parse(result.stdout).find((row) => row.name === "runtime config");
    const ignored = cli(repo.root, ["doctor", "--json"], env);
    assert.equal(source(ignored).detail, userConfig);
    assert.match(
      ignored.stderr,
      /ignored repository runtime config.*--trust-repo-runtimes.*APOCHA_TRUST_REPO_RUNTIMES=1/,
    );
    const flag = cli(repo.root, ["doctor", "--json", "--trust-repo-runtimes"], env);
    assert.equal(source(flag).detail, repoConfig);
    assert.equal(flag.stderr, "");
    const trustedEnv = { ...env, APOCHA_TRUST_REPO_RUNTIMES: "1" };
    const trusted = cli(repo.root, ["doctor", "--json"], trustedEnv);
    assert.equal(source(trusted).detail, repoConfig);
    assert.equal(trusted.stderr, "");
    const explicit = cli(repo.root, ["doctor", "--json", "--runtimes", explicitConfig], env);
    assert.equal(source(explicit).detail, explicitConfig);
    assert.equal(explicit.stderr, "");
    const explicitTrusted = cli(
      repo.root,
      ["doctor", "--json", "--runtimes", explicitConfig, "--trust-repo-runtimes"],
      trustedEnv,
    );
    assert.equal(source(explicitTrusted).detail, explicitConfig);
    rmSync(userConfig);
    writeFileSync(repoConfig, "invalid JSON must not be read without trust");
    const missing = cli(repo.root, ["doctor", "--json"], env);
    assert.equal(source(missing).ok, false);
    assert.match(source(missing).detail, /no runtime config found.*--trust-repo-runtimes/);
    assert.match(missing.stderr, /ignored repository runtime config/);
    const missingExplicit = cli(repo.root, ["doctor", "--json", "--runtimes", userConfig], trustedEnv);
    assert.equal(source(missingExplicit).ok, false);
    assert.match(source(missingExplicit).detail, /runtime config not found/);
  } finally {
    repo.cleanup();
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("validate prints the normalized task and rejects bad ones", () => {
  const repo = makeRepo();
  try {
    const file = path.join(repo.root, "task.json");
    writeFileSync(
      file,
      JSON.stringify({
        task_id: "t1",
        description: "d",
        acceptance_criteria: ["c"],
        allowed_paths: ["src/"],
      }),
    );
    const ok = cli(repo.root, ["validate", file]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).checks, ["test"]);
    writeFileSync(
      file,
      JSON.stringify({
        task_id: "t1",
        description: "d",
        acceptance_criteria: ["c"],
        allowed_paths: ["src/"],
        checks: ["rm"],
      }),
    );
    const bad = cli(repo.root, ["validate", file]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown check/);
  } finally {
    repo.cleanup();
  }
});

test("run with a scripted fake runtime warns when auto has no sandbox and passes", () => {
  const repo = makeRepo({
    config: {
      version: 1,
      checks: { test: { run: ["node", "check.mjs"] } },
      default_checks: ["test"],
      sandbox: { mode: "auto" },
    },
  });
  try {
    const fixtures = testTempDir("cli-runtime");
    const script = path.join(fixtures, "fake.mjs");
    writeFileSync(
      script,
      `export default {
  async implementer({ bundle, call }) {
    await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
    await call("submit_result", { summary: "set to 2", criteria_evidence: bundle.acceptance_criteria.map((_, index) => ({ criterion: index + 1, evidence: [{ kind: "check", check_id: bundle.checks[0].id }] })) });
  },
  async reviewer({ bundle, call }) {
    await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
  },
};
`,
    );
    const runtimes = path.join(fixtures, "runtimes.json");
    writeFileSync(
      runtimes,
      JSON.stringify({
        version: 1,
        roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        adapters: { fake: { script } },
      }),
    );
    const task = path.join(fixtures, "task.json");
    writeFileSync(
      task,
      JSON.stringify({
        task_id: "cli-run",
        description: "Set src/value.txt to 2",
        acceptance_criteria: ["value is 2"],
        allowed_paths: ["src/"],
      }),
    );
    const run = cli(
      repo.root,
      [
        "run",
        task,
        "--base",
        "main",
        "--batch",
        "cli-run",
        "--message",
        "Set value",
        "--runtimes",
        runtimes,
        "--json",
        "--quiet",
      ],
      { APOCHA_SANDBOX: "1" },
    );
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.match(run.stderr, /warning:.*no sandbox backend.*sandbox.mode.*required/);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.outcome, "PASSED");
    const warning = new RunStore(repo.root)
      .events(summary.run_id)
      .find((event) => event.type === "sandbox.warning");
    assert.equal(warning?.reason, "sandbox_unavailable");
    assert.match(warning?.message ?? "", /without an OS sandbox/);
    const receipt = cli(repo.root, ["receipt", summary.promoted_head]);
    assert.equal(receipt.code, 0);
    assert.equal(JSON.parse(receipt.stdout).valid, true);
    const runs = cli(repo.root, ["runs"]);
    assert.match(runs.stdout, /^PASSED\s+cli-run-/m);
    const metrics = cli(repo.root, ["metrics", "--json"]);
    assert.equal(JSON.parse(metrics.stdout).runs.by_outcome.PASSED, 1);
    const kept = cli(repo.root, ["land", "apocha/batch/cli-run", "--target", "main", "--keep-batch"]);
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stdout, /kept .*keep-batch/);
    assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/cli-run"), summary.promoted_head);
    // Restore the target to exercise retirement on another fast-forward.
    git(repo.root, ["reset", "--hard", `${summary.promoted_head}^`]);
    const land = cli(repo.root, ["land", "apocha/batch/cli-run", "--target", "main"]);
    assert.equal(land.code, 0, land.stderr);
    assert.match(land.stdout, /landed 1 commit/);
    assert.ok(land.stdout.includes(`retired refs/heads/apocha/batch/cli-run ${summary.promoted_head}`));
    assert.match(land.stdout, /land record: .*apocha\/lands\/.*\.json/);
    assert.equal(resolveCommit(repo.root, "refs/heads/apocha/batch/cli-run"), null);
    const afterLand = cli(repo.root, ["receipt", summary.promoted_head]);
    assert.equal(afterLand.code, 0, afterLand.stderr);
    assert.equal(JSON.parse(afterLand.stdout).valid, true);
  } finally {
    repo.cleanup();
  }
});

test("message options conflict with a usage error on run and integrate", () => {
  for (const command of ["run", "integrate"]) {
    const result = cli(os.tmpdir(), [
      command,
      "input",
      command === "run" ? "--base" : "--onto",
      "main",
      "--batch",
      "conflict",
      "--message",
      "",
      "--message-file",
      "missing.txt",
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /--message and --message-file are mutually exclusive/);
  }
});

test("validate explains how to make initial_context readable", () => {
  const repo = makeRepo();
  const fixtures = testTempDir("cli-context");
  try {
    const task = path.join(fixtures, "task.json");
    writeFileSync(
      task,
      JSON.stringify({
        task_id: "context-hint",
        description: "Read documentation",
        acceptance_criteria: ["context is readable"],
        allowed_paths: ["src/"],
        initial_context: ["README.md"],
      }),
    );
    const result = cli(repo.root, ["validate", task]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(
      result.stderr,
      /initial_context entry README\.md is outside allowed_paths and read_only_paths; add it to read_only_paths to let the agent read it without editing it/,
    );
  } finally {
    repo.cleanup();
  }
});

for (const command of ["run", "integrate"]) {
  for (const mode of ["file", "literal", "shorthand"]) {
    test(`${command} promotes the commit message from ${mode}`, () => {
      const repo = makeRepo();
      const fixtures = testTempDir("cli-message");
      try {
        const script = path.join(fixtures, "fake.mjs");
        writeFileSync(
          script,
          `export default {
  async implementer({ bundle, call }) {
    await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\\n", new_text: "2\\n" }] });
    await call("submit_result", { summary: "set to 2", criteria_evidence: bundle.acceptance_criteria.map((_, index) => ({ criterion: index + 1, evidence: [{ kind: "check", check_id: bundle.checks[0].id }] })) });
  },
  async reviewer({ bundle, call }) {
    await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
  },
};
`,
        );
        const runtimes = path.join(fixtures, "runtimes.json");
        writeFileSync(
          runtimes,
          JSON.stringify({
            version: 1,
            roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
            adapters: { fake: { script } },
          }),
        );
        const task = path.join(fixtures, "task.json");
        writeFileSync(
          task,
          JSON.stringify({
            task_id: "cli-message",
            description: "Set src/value.txt to 2",
            acceptance_criteria: ["value is 2"],
            allowed_paths: ["src/"],
          }),
        );
        if (command === "integrate") {
          git(repo.root, ["checkout", "-qb", "topic"]);
          writeFileSync(path.join(repo.root, "src/value.txt"), "2\n");
          git(repo.root, ["commit", "-qam", "Topic change"]);
          git(repo.root, ["checkout", "-q", "main"]);
        }
        const messageFile = "message.txt";
        const expected = mode === "literal" ? "@literal" : "@file contents\n\nMessage body";
        writeFileSync(path.join(repo.root, messageFile), `${expected}\n`);
        const messageArgs =
          mode === "file"
            ? ["--message-file", messageFile]
            : ["--message", mode === "literal" ? "@@literal" : `@${messageFile}`];
        const result = cli(repo.root, [
          command,
          command === "run" ? task : "topic",
          command === "run" ? "--base" : "--onto",
          "main",
          "--batch",
          "cli-message",
          ...messageArgs,
          "--runtimes",
          runtimes,
          "--json",
          "--quiet",
        ]);
        assert.equal(result.code, 0, result.stderr + result.stdout);
        const summary = JSON.parse(result.stdout);
        assert.equal(summary.outcome, "PASSED");
        const message = git(repo.root, ["show", "-s", "--format=%B", summary.promoted_head]);
        assert.equal(String(message.stdout).trimEnd(), expected);
      } finally {
        repo.cleanup();
      }
    });
  }
}

test("integrate requires allowed for existing test rewrites and exposes them to review", () => {
  const original = 'import { test } from "node:test";\ntest("existing", () => {});\n';
  const repo = makeRepo({ files: { "test/existing.test.mjs": original } });
  const fixtures = testTempDir("cli-integration-tests");
  try {
    git(repo.root, ["checkout", "-qb", "topic"]);
    writeFileSync(
      path.join(repo.root, "test/existing.test.mjs"),
      original.replace('"existing"', '"modified"'),
    );
    git(repo.root, ["commit", "-qam", "Modify existing test"]);
    git(repo.root, ["checkout", "-q", "main"]);
    const bundleFile = path.join(fixtures, "review.json");
    const script = path.join(fixtures, "fake.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
export default {
  async reviewer({ bundle, call }) {
    writeFileSync(${JSON.stringify(bundleFile)}, JSON.stringify(bundle));
    await call("submit_result", { decision: "PASS", findings: [], candidate_digest: bundle.candidate.candidate_digest });
  },
};
`,
    );
    const runtimes = path.join(fixtures, "runtimes.json");
    writeFileSync(
      runtimes,
      JSON.stringify({
        version: 1,
        roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
        adapters: { fake: { script } },
      }),
    );
    const args = [
      "integrate",
      "topic",
      "--onto",
      "main",
      "--batch",
      "test-policy",
      "--checks",
      "ok",
      "--max-repairs",
      "0",
      "--runtimes",
      runtimes,
      "--json",
      "--quiet",
    ];
    const denied = cli(repo.root, args);
    assert.equal(denied.code, 20, denied.stderr + denied.stdout);
    const failed = JSON.parse(denied.stdout);
    assert.equal(failed.outcome, "FAILED");
    assert.ok(failed.checks.some((check) => check.id === "test-edits" && check.status === "fail"));
    const store = new RunStore(repo.root);
    const deniedRecord = store.read(failed.run_id);
    assert.equal(deniedRecord.task.test_edits, "additive");
    assert.deepEqual(
      deniedRecord.state.last_verification.checks.find((check) => check.id === "test-edits").files,
      ["test/existing.test.mjs"],
    );
    const allowed = cli(repo.root, [...args, "--test-edits", "allowed"]);
    assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
    const passed = JSON.parse(allowed.stdout);
    assert.equal(passed.outcome, "PASSED");
    assert.ok(passed.checks.some((check) => check.id === "test-edits" && check.status === "pass"));
    const bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
    assert.deepEqual(bundle.modified_tests, ["test/existing.test.mjs"]);
    assert.match(bundle.diff, /\+test\("modified"/);
    const record = store.read(passed.run_id);
    assert.equal(record.task.test_edits, "allowed");
    assert.equal(record.task_digest, taskDigest(record.task));
    assert.notEqual(record.task_digest, taskDigest({ ...record.task, test_edits: "additive" }));
    assert.equal(
      store.events(passed.run_id).find((event) => event.type === "merge.finished")?.test_edits,
      "allowed",
    );
  } finally {
    repo.cleanup();
  }
});

test("integrate rejects invalid test edit policies as usage errors", () => {
  for (const policy of ["invalid", "Allowed", ""]) {
    const result = cli(os.tmpdir(), [
      "integrate",
      "topic",
      "--onto",
      "main",
      "--batch",
      "invalid-policy",
      "--test-edits",
      policy,
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /--test-edits must be one of additive, new-files, allowed/);
  }
});

test("help documents integration test edit policy and review visibility", () => {
  const result = cli(os.tmpdir(), ["help"]);
  assert.match(result.stdout, /--test-edits <policy>/);
  assert.match(result.stdout, /additive.*new-files.*allowed/);
  assert.match(result.stdout, /reviewer sees every changed existing test/);
});

test("help documents message files and literal leading at signs", () => {
  const result = cli(os.tmpdir(), ["help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--message-file <path>/);
  assert.match(result.stdout, /--message @@text for a literal leading @/);
});
