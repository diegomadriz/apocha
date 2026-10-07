// @ts-check
import assert from "node:assert/strict";
import { existsSync, linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeProjectConfig } from "../src/config/project.mjs";

import { toolDefinitions } from "../src/tools/definitions.mjs";
import { createProjectTools, readSession, TOOL_LIMITS } from "../src/tools/project-tools.mjs";
import { testCandidate as createCandidate, makeRepo, testTempDir } from "./helpers.mjs";

/**
 * @param {Partial<import("../src/tools/project-tools.mjs").SessionConfig>} overrides
 * @param {Record<string, string>} [files]
 */
function setup(overrides = {}, files = {}) {
  const repo = makeRepo({
    files: {
      "docs/guide.md": "guide\nline two\n",
      "src/big.txt": "x".repeat(300000),
      "src/a.txt": "alpha\nbeta\n",
      ...files,
    },
  });
  const candidate = createCandidate(repo.root, "main");
  const sessionDir = testTempDir("session");
  const project = normalizeProjectConfig(
    {
      version: 1,
      checks: { test: { run: ["node", "check.mjs"], cwd: "." } },
      paths: { forbidden: ["private/"] },
      sandbox: { mode: "none" },
    },
    repo.root,
  );
  const session = {
    version: /** @type {1} */ (1),
    role: /** @type {"implementer" | "reviewer"} */ ("implementer"),
    root: candidate.root,
    repository_root: repo.root,
    base_commit: candidate.base_commit,
    allowed_paths: ["src/"],
    read_only_paths: ["docs/"],
    protected_paths: ["src/locked.txt"],
    forbidden_paths: ["private/"],
    deleted_paths: [],
    run_checks: ["test"],
    max_tool_calls: 50,
    max_run_check_calls: 2,
    sandbox_backend: /** @type {const} */ ("none"),
    project,
    session_dir: sessionDir,
    ...overrides,
  };
  const tools = createProjectTools(session);
  return {
    tools,
    candidate,
    sessionDir,
    root: candidate.root,
    cleanup() {
      candidate.cleanup();
      repo.cleanup();
    },
  };
}

test("read traces include requested paths on success and failure without contents", async () => {
  const s = setup();
  try {
    for (const name of ["read_files", "read_file_range", "read_base_file", "stat_paths"]) {
      for (const [requested, ok] of [
        ["src/a.txt", true],
        ["README.md", false],
      ]) {
        const args =
          name === "read_files" || name === "stat_paths"
            ? { paths: [requested] }
            : { path: requested, start_line: 1, end_line: 2 };
        const result = await s.tools.call(name, args);
        assert.equal(result.ok, ok);
        const entry = readSession(s.sessionDir).trace.at(-1);
        assert.deepEqual(entry.paths, [requested]);
        assert.equal(entry.ok, ok);
        assert.deepEqual(
          Object.keys(entry).sort(),
          (ok ? ["at", "tool", "ok", "paths"] : ["at", "tool", "ok", "paths", "error_code"]).sort(),
        );
      }
    }
    const trace = readFileSync(path.join(s.sessionDir, "tools.jsonl"), "utf8");
    assert.equal(trace.includes("alpha"), false);
    assert.equal(trace.includes("beta"), false);
    assert.equal(trace.includes("content"), false);
  } finally {
    s.cleanup();
  }
});

test("search traces record paths and query length on success and failure, never query text", async () => {
  const s = setup();
  try {
    const query = "alpha";
    for (const [paths, ok] of [
      [["src/a.txt"], true],
      [["README.md"], false],
      [undefined, true],
    ]) {
      assert.equal((await s.tools.call("search_code", { query, paths })).ok, ok);
      const entry = readSession(s.sessionDir).trace.at(-1);
      assert.equal(entry.query_length, query.length);
      if (paths === undefined) assert.equal(Object.hasOwn(entry, "paths"), false);
      else assert.deepEqual(entry.paths, paths);
      assert.equal(Object.hasOwn(entry, "query"), false);
      assert.equal(Object.hasOwn(entry, "results"), false);
    }
    const invalidQuery = "secret".repeat(200);
    assert.equal((await s.tools.call("search_code", { query: invalidQuery, paths: ["src/"] })).ok, false);
    const entry = readSession(s.sessionDir).trace.at(-1);
    assert.deepEqual(entry.paths, ["src/"]);
    assert.equal(entry.query_length, invalidQuery.length);
    const trace = readFileSync(path.join(s.sessionDir, "tools.jsonl"), "utf8");
    assert.equal(trace.includes(query), false);
    assert.equal(trace.includes(invalidQuery), false);
  } finally {
    s.cleanup();
  }
});

test("patch traces include all requested paths on failure and omit edit text", async () => {
  const s = setup();
  try {
    const edits = [
      { path: "README.md", old_text: "secret old text", new_text: "secret new text" },
      { path: "src/a.txt", old_text: "alpha", new_text: "replacement" },
    ];
    assert.equal((await s.tools.call("apply_patch", { edits })).ok, false);
    const failed = readSession(s.sessionDir).trace.at(-1);
    assert.deepEqual(
      failed.paths,
      edits.map((edit) => edit.path),
    );
    assert.equal(failed.ok, false);
    assert.equal(Object.hasOwn(failed, "changed"), false);
    assert.equal((await s.tools.call("apply_patch", { edits: [edits[1]] })).ok, true);
    const success = readSession(s.sessionDir).trace.at(-1);
    assert.deepEqual(success.changed, ["src/a.txt"]);
    assert.deepEqual(success.paths, ["src/a.txt"]);
    const trace = readFileSync(path.join(s.sessionDir, "tools.jsonl"), "utf8");
    for (const text of ["old_text", "new_text", "secret old text", "secret new text", "alpha", "replacement"])
      assert.equal(trace.includes(text), false);
  } finally {
    s.cleanup();
  }
});

test("trace path lists and changed paths are bounded, including invalid requests", async () => {
  const s = setup();
  try {
    const paths = Array.from({ length: 25 }, (_, index) => `src/${index}-${"x".repeat(220)}.txt`);
    const expected = paths.slice(0, 20).map((value) => value.slice(0, 200));
    for (const name of ["read_files", "stat_paths", "search_code", "apply_patch"]) {
      const args =
        name === "apply_patch"
          ? { edits: paths.map((value) => ({ path: value, delete: true })) }
          : { paths, query: "private query" };
      assert.equal((await s.tools.call(name, args)).ok, false);
      assert.deepEqual(readSession(s.sessionDir).trace.at(-1).paths, expected);
    }
    for (const name of ["read_file_range", "read_base_file"]) {
      assert.equal((await s.tools.call(name, { path: paths[0] })).ok, name === "read_base_file");
      assert.deepEqual(readSession(s.sessionDir).trace.at(-1).paths, [expected[0]]);
    }
    await s.tools.call("read_files", { paths: [{ content: "private contents" }, paths[0]] });
    assert.deepEqual(readSession(s.sessionDir).trace.at(-1).paths, [expected[0]]);
    await s.tools.call("apply_patch", {
      edits: [null, { path: { old_text: "private contents" } }, { path: paths[0], delete: true }],
    });
    assert.deepEqual(readSession(s.sessionDir).trace.at(-1).paths, [expected[0]]);
    const changedPaths = Array.from({ length: 21 }, (_, index) => `src/new-${index}.txt`);
    assert.equal(
      (
        await s.tools.call("apply_patch", {
          edits: changedPaths.map((value) => ({ path: value, old_text: "", new_text: "private contents" })),
        })
      ).ok,
      true,
    );
    const entry = readSession(s.sessionDir).trace.at(-1);
    assert.deepEqual(entry.paths, changedPaths.slice(0, 20));
    assert.deepEqual(entry.changed, changedPaths.slice(0, 20));
    const trace = readFileSync(path.join(s.sessionDir, "tools.jsonl"), "utf8");
    assert.equal(trace.includes("private contents"), false);
    assert.equal(trace.includes("private query"), false);
  } finally {
    s.cleanup();
  }
});

test("budget failures still trace the requested paths", async () => {
  const s = setup({ max_tool_calls: 0 });
  try {
    assert.equal((await s.tools.call("read_files", { paths: ["README.md"] })).ok, false);
    const entry = readSession(s.sessionDir).trace[0];
    assert.deepEqual(entry.paths, ["README.md"]);
    assert.equal(entry.error_code, "budget");
  } finally {
    s.cleanup();
  }
});

test("reads stay inside allowed and read-only scopes, never forbidden paths", async () => {
  const s = setup();
  try {
    const ok = await s.tools.call("read_files", { paths: ["src/a.txt", "docs/guide.md"] });
    assert.equal(ok.ok, true);
    assert.equal(/** @type {any} */ (ok.value).files[1].content, "guide\nline two\n");
    for (const bad of [
      "README.md",
      "private/secret.txt",
      "../etc/passwd",
      "/etc/passwd",
      ".git/config",
      "src/../README.md",
    ]) {
      const result = await s.tools.call("read_files", { paths: [bad] });
      assert.equal(result.ok, false, bad);
    }
  } finally {
    s.cleanup();
  }
});

test("the reviewer can read the whole candidate except forbidden paths, and cannot edit", async () => {
  const s = setup({ role: "reviewer", allowed_paths: [] });
  try {
    assert.equal((await s.tools.call("read_files", { paths: ["README.md"] })).ok, true);
    assert.equal((await s.tools.call("read_files", { paths: ["private/secret.txt"] })).ok, false);
    const patch = await s.tools.call("apply_patch", {
      edits: [{ path: "src/a.txt", old_text: "alpha", new_text: "x" }],
    });
    assert.equal(patch.ok, false);
    assert.match(patch.error, /unknown tool/);
  } finally {
    s.cleanup();
  }
});

test("symlinks inside the candidate are refused", async () => {
  const s = setup();
  try {
    symlinkSync("/etc/hosts", path.join(s.root, "src", "link.txt"));
    const result = await s.tools.call("read_files", { paths: ["src/link.txt"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /symlink/);
  } finally {
    s.cleanup();
  }
});

test("large files point the agent at read_file_range", async () => {
  const s = setup();
  try {
    const result = await s.tools.call("read_files", { paths: ["src/big.txt"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /read_file_range/);
    const range = await s.tools.call("read_file_range", { path: "src/a.txt", start_line: 2, end_line: 9 });
    assert.equal(/** @type {any} */ (range.value).content, "beta\n");
  } finally {
    s.cleanup();
  }
});

test("apply_patch composes several edits to one file in order", async () => {
  const s = setup();
  try {
    const result = await s.tools.call("apply_patch", {
      edits: [
        { path: "src/a.txt", old_text: "alpha", new_text: "ALPHA" },
        { path: "src/a.txt", old_text: "beta", new_text: "BETA" },
        { path: "src/new.txt", old_text: "", new_text: "created\n" },
      ],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(path.join(s.root, "src/a.txt"), "utf8"), "ALPHA\nBETA\n");
    assert.equal(readFileSync(path.join(s.root, "src/new.txt"), "utf8"), "created\n");
  } finally {
    s.cleanup();
  }
});

test("apply_patch is all-or-nothing and refuses protected, ambiguous, and missing targets", async () => {
  const s = setup({}, { "src/dup.txt": "same\nsame\n" });
  try {
    const failing = await s.tools.call("apply_patch", {
      edits: [
        { path: "src/a.txt", old_text: "alpha", new_text: "changed" },
        { path: "src/dup.txt", old_text: "same", new_text: "x" },
      ],
    });
    assert.equal(failing.ok, false);
    assert.match(failing.error, /more than once/);
    assert.equal(readFileSync(path.join(s.root, "src/a.txt"), "utf8"), "alpha\nbeta\n", "no partial write");
    assert.match(
      (
        await s.tools.call("apply_patch", {
          edits: [{ path: "src/locked.txt", old_text: "", new_text: "x" }],
        })
      ).error,
      /protected/,
    );
    assert.match(
      (await s.tools.call("apply_patch", { edits: [{ path: "src/a.txt", old_text: "nope", new_text: "x" }] }))
        .error,
      /not found/,
    );
    assert.match(
      (
        await s.tools.call("apply_patch", {
          edits: [{ path: "docs/guide.md", old_text: "guide", new_text: "x" }],
        })
      ).error,
      /outside allowed_paths/,
    );
  } finally {
    s.cleanup();
  }
});

test("apply_patch leaves files unchanged when the second file exceeds the size limit", async () => {
  const original = `${"x".repeat(TOOL_LIMITS.maxPatchableFileBytes - 3)}end`;
  const s = setup({}, { "src/limit.txt": original });
  try {
    const result = await s.tools.call("apply_patch", {
      edits: [
        { path: "src/a.txt", old_text: "alpha", new_text: "changed" },
        { path: "src/limit.txt", old_text: "end", new_text: "longer" },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /would exceed the file size limit/);
    assert.equal(readFileSync(path.join(s.root, "src/a.txt"), "utf8"), "alpha\nbeta\n");
    assert.equal(readFileSync(path.join(s.root, "src/limit.txt"), "utf8"), original);
  } finally {
    s.cleanup();
  }
});

test("apply_patch can delete a file, and reading it afterwards reports it missing", async () => {
  const s = setup();
  try {
    assert.equal(
      (await s.tools.call("apply_patch", { edits: [{ path: "src/a.txt", delete: true }] })).ok,
      true,
    );
    assert.equal(existsSync(path.join(s.root, "src/a.txt")), false);
    const read = await s.tools.call("read_files", { paths: ["src/a.txt"] });
    assert.equal(/** @type {any} */ (read.value).files[0].missing, true);
    const base = await s.tools.call("read_base_file", { path: "src/a.txt" });
    assert.equal(/** @type {any} */ (base.value).content, "alpha\nbeta\n");
  } finally {
    s.cleanup();
  }
});

test("reviewer reads of files the candidate deleted report deleted_in_candidate", async () => {
  const s = setup({ role: "reviewer", allowed_paths: [], deleted_paths: ["src/a.txt"] });
  try {
    const read = await s.tools.call("read_files", { paths: ["src/a.txt"] });
    assert.equal(read.ok, true);
    assert.equal(/** @type {any} */ (read.value).files[0].deleted_in_candidate, true);
  } finally {
    s.cleanup();
  }
});

test("run_check runs only the task's checks, within its budget, and reports failure lines", async () => {
  const s = setup();
  try {
    const first = await s.tools.call("run_check", { check_id: "test" });
    assert.equal(first.ok, true, first.error);
    assert.equal(/** @type {any} */ (first.value).status, "fail");
    assert.match(/** @type {any} */ (first.value).output, /expected 2, got 1/);
    assert.match((await s.tools.call("run_check", { check_id: "lint" })).error, /not available/);
    await s.tools.call("run_check", { check_id: "test" });
    assert.match((await s.tools.call("run_check", { check_id: "test" })).error, /budget/);
  } finally {
    s.cleanup();
  }
});

test("submit_result validates against the role schema and accepts one result", async () => {
  const s = setup();
  try {
    assert.match((await s.tools.call("submit_result", { nope: true })).error, /result is invalid/);
    assert.equal((await s.tools.call("submit_result", { summary: "done" })).ok, true);
    assert.match((await s.tools.call("submit_result", { summary: "again" })).error, /already submitted/);
    const { trace, result } = readSession(s.sessionDir);
    assert.deepEqual(result, { summary: "done" });
    assert.equal(trace.length, 3);
  } finally {
    s.cleanup();
  }
});

test("the tool-call budget leaves room for submit_result", async () => {
  const s = setup({ max_tool_calls: 2 });
  try {
    await s.tools.call("stat_paths", { paths: ["src/a.txt"] });
    await s.tools.call("stat_paths", { paths: ["src/a.txt"] });
    assert.match((await s.tools.call("stat_paths", { paths: ["src/a.txt"] })).error, /budget exhausted/);
    assert.equal((await s.tools.call("submit_result", { summary: "done" })).ok, true);
  } finally {
    s.cleanup();
  }
});

test("search_code skips forbidden paths and hardlinked files never escape scope", async () => {
  const s = setup();
  try {
    const result = await s.tools.call("search_code", { query: "alpha" });
    assert.deepEqual(
      /** @type {any} */ (result.value).results.map((hit) => hit.path),
      ["src/a.txt"],
    );
    writeFileSync(path.join(s.root, "outside.txt"), "x");
    linkSync(path.join(s.root, "outside.txt"), path.join(s.root, "src", "hard.txt"));
    // Hardlinks can be read like any file, but the candidate snapshot rejects them (see candidate tests).
    assert.equal((await s.tools.call("stat_paths", { paths: ["src/hard.txt"] })).ok, true);
  } finally {
    s.cleanup();
  }
});

test("advertised result schema omits conditional keywords while full validation remains", async () => {
  const schema = toolDefinitions("implementer").find((tool) => tool.name === "submit_result").inputSchema;
  for (const keyword of ["if", "then", "else", "not", "allOf", "anyOf", "oneOf"])
    assert.equal(Object.hasOwn(schema, keyword), false, keyword);
  assert.ok(schema.properties.status);
  assert.ok(schema.properties.blocked_reason);
  assert.match(schema.properties.status.description, /requires blocked_reason/);
  assert.match(schema.properties.blocked_reason.description, /Must be omitted otherwise/);
  const s = setup();
  try {
    assert.equal((await s.tools.call("submit_result", { status: "blocked", summary: "blocked" })).ok, false);
    assert.equal(
      (await s.tools.call("submit_result", { status: "done", summary: "done", blocked_reason: "reason" })).ok,
      false,
    );
    assert.equal(
      (
        await s.tools.call("submit_result", {
          status: "blocked",
          summary: "blocked",
          blocked_reason: "required test change",
        })
      ).ok,
      true,
    );
  } finally {
    s.cleanup();
  }
});
