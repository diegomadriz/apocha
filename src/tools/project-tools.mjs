// @ts-check
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { runCheck } from "../checks/runner.mjs";
import { classifyTestFileChange, existingTestFiles } from "../git/test-edits.mjs";
import { failureFirst } from "../util/bounded.mjs";
import { HarnessError, isObject } from "../util/errors.mjs";
import {
  appendJsonLine,
  looksBinary,
  readHead,
  readRegularFile,
  resolveInside,
  writeJsonAtomic,
} from "../util/fs-safe.mjs";
import { git, gitBuffer } from "../util/git.mjs";
import { canonicalPath, inAnyScope, isForbidden } from "../util/paths.mjs";
import { loadSchema, validateAgainst } from "../util/schema.mjs";

/**
 * The harness tools, implemented once and served to every runtime (through
 * MCP for Codex and Claude Code, through an extension for Pi).
 *
 * Every tool is confined to the candidate and to the task's scopes. A tool
 * failure is returned to the agent as a tool error with guidance; it never
 * ends the run. The run ends only when the agent calls `submit_result`, or
 * when the controller's budget or timeout stops it.
 *
 * The session directory is the single source of truth for what happened:
 * `tools.jsonl` (one line per call) and `result.json` (the submitted result).
 */

export const TOOL_LIMITS = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 200000,
  maxRangeFileBytes: 2000000,
  maxOutputBytes: 250000,
  maxSearchResults: 100,
  maxSearchFiles: 5000,
  maxEdits: 30,
  maxPatchTextBytes: 100000,
  maxPatchableFileBytes: 2000000,
});

/**
 * @typedef {{
 *   version: 1,
 *   role: "implementer" | "reviewer",
 *   root: string,
 *   repository_root: string,
 *   base_commit: string,
 *   allowed_paths: string[],
 *   read_only_paths: string[],
 *   protected_paths: string[],
 *   forbidden_paths: string[],
 *   deleted_paths: string[],
 *   test_edits?: import("../config/task.mjs").Task["test_edits"],
 *   existing_test_files?: string[],
 *   run_checks: string[],
 *   max_tool_calls: number,
 *   max_run_check_calls: number,
 *   sandbox_backend: import("../sandbox/index.mjs").SandboxBackend,
 *   project: import("../config/project.mjs").ProjectConfig,
 *   session_dir: string,
 * }} SessionConfig
 */

/** @param {string} message @param {string} [code] */
function toolError(message, code = "invalid_request") {
  return new HarnessError("agent", code, message);
}

/** @param {unknown} paths */
function tracePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((value) => typeof value === "string")
    .slice(0, 20)
    .map((value) => value.slice(0, 200));
}

/** @param {SessionConfig} session */
export function createProjectTools(session) {
  const root = session.root;
  const testPolicy = session.test_edits ?? "additive";
  const existingTests = new Set(session.existing_test_files ?? existingTestFiles(session, session.project));
  const readableScopes = [...session.allowed_paths, ...session.read_only_paths];
  const deleted = new Set(session.role === "reviewer" ? session.deleted_paths : []);
  const traceFile = path.join(session.session_dir, "tools.jsonl");
  const resultFile = path.join(session.session_dir, "result.json");
  mkdirSync(session.session_dir, { recursive: true, mode: 0o700 });
  let calls = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).length : 0;
  let runCheckCalls = 0;

  /** @param {unknown} value @param {string} [label] */
  function readablePath(value, label = "path") {
    const relative = canonicalPath(value, label);
    if (isForbidden(relative, session.forbidden_paths))
      throw toolError(`path is not readable: ${relative}`, "forbidden");
    // The reviewer may read the whole candidate (minus forbidden paths) to judge the change in context.
    if (session.role !== "reviewer" && !inAnyScope(relative, readableScopes)) {
      throw toolError(`path is outside allowed_paths and read_only_paths: ${relative}`, "out_of_scope");
    }
    return relative;
  }

  /** @param {unknown} value */
  function writablePath(value) {
    const relative = canonicalPath(value, "path");
    if (isForbidden(relative, session.forbidden_paths))
      throw toolError(`path is not writable: ${relative}`, "forbidden");
    if (!inAnyScope(relative, session.allowed_paths))
      throw toolError(`path is outside allowed_paths: ${relative}`, "out_of_scope");
    if (inAnyScope(relative, session.protected_paths))
      throw toolError(`path is protected: ${relative}`, "protected");
    return relative;
  }

  /** @template T @param {T} value */
  function bounded(value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > TOOL_LIMITS.maxOutputBytes) {
      throw toolError(
        `result exceeds ${TOOL_LIMITS.maxOutputBytes} bytes; request fewer files or use read_file_range on a smaller range`,
        "too_large",
      );
    }
    return value;
  }

  function stat_paths({ paths }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > TOOL_LIMITS.maxFiles)
      throw toolError(`paths must list 1-${TOOL_LIMITS.maxFiles} entries`);
    return {
      paths: paths.map((value) => {
        const relative = readablePath(value);
        const missing = { path: relative, exists: false, type: "missing", bytes: 0, binary: false };
        if (deleted.has(relative)) return { ...missing, deleted_in_candidate: true };
        const { absolute, exists } = resolveInside(root, relative.replace(/\/$/, "") || ".", {
          allowMissing: true,
        });
        if (!exists) return missing;
        const stat = lstatSync(absolute);
        if (stat.isDirectory())
          return { path: relative, exists: true, type: "directory", bytes: 0, binary: false };
        if (!stat.isFile())
          return { path: relative, exists: true, type: "other", bytes: stat.size, binary: false };
        const head = readHead(absolute);
        return { path: relative, exists: true, type: "file", bytes: stat.size, binary: looksBinary(head) };
      }),
    };
  }

  function read_files({ paths }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > TOOL_LIMITS.maxFiles)
      throw toolError(`paths must list 1-${TOOL_LIMITS.maxFiles} entries`);
    return bounded({
      files: paths.map((value) => {
        const relative = readablePath(value);
        if (deleted.has(relative)) return { path: relative, deleted_in_candidate: true, content: "" };
        const { absolute, exists } = resolveInside(root, relative, { allowMissing: true });
        if (!exists) return { path: relative, missing: true, content: "" };
        const stat = lstatSync(absolute);
        if (!stat.isFile()) throw toolError(`not a file: ${relative}`, "not_a_file");
        if (stat.size > TOOL_LIMITS.maxFileBytes) {
          throw toolError(
            `${relative} is ${stat.size} bytes; use read_file_range for files over ${TOOL_LIMITS.maxFileBytes} bytes`,
            "too_large",
          );
        }
        const buffer = readRegularFile(absolute, TOOL_LIMITS.maxFileBytes);
        if (looksBinary(buffer)) return { path: relative, binary: true, bytes: buffer.length, content: "" };
        return { path: relative, content: buffer.toString("utf8") };
      }),
    });
  }

  function read_file_range({ path: value, start_line, end_line }) {
    if (
      !Number.isSafeInteger(start_line) ||
      !Number.isSafeInteger(end_line) ||
      start_line < 1 ||
      end_line < start_line
    ) {
      throw toolError("start_line and end_line must be positive integers with start_line <= end_line");
    }
    const relative = readablePath(value);
    if (deleted.has(relative)) return { path: relative, deleted_in_candidate: true, content: "" };
    const { absolute } = resolveInside(root, relative);
    const buffer = readRegularFile(absolute, TOOL_LIMITS.maxRangeFileBytes);
    if (looksBinary(buffer)) return { path: relative, binary: true, bytes: buffer.length, content: "" };
    const lines = buffer.toString("utf8").split("\n");
    return bounded({
      path: relative,
      start_line,
      end_line: Math.min(end_line, lines.length),
      total_lines: lines.length,
      content: lines.slice(start_line - 1, end_line).join("\n"),
    });
  }

  /** @param {{ path: unknown }} args @param {number} [maxBytes] */
  function read_base_file({ path: value }, maxBytes = TOOL_LIMITS.maxFileBytes) {
    const relative = readablePath(value);
    const listed = git(root, ["ls-tree", "-l", "-z", session.base_commit, "--", relative]);
    const entry = String(listed.stdout).split("\0").find(Boolean);
    if (!entry) return { path: relative, exists_at_base: false, content: "" };
    const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t/.exec(entry);
    if (match?.[2] !== "blob" || match[1] === "120000")
      throw toolError(`not a regular file at base: ${relative}`, "not_a_file");
    if (Number(match[4]) > maxBytes)
      throw toolError(`${relative} at base exceeds ${maxBytes} bytes`, "too_large");
    const buffer = gitBuffer(root, ["cat-file", "blob", match[3]]);
    if (looksBinary(buffer))
      return { path: relative, exists_at_base: true, binary: true, bytes: buffer.length, content: "" };
    return bounded({ path: relative, exists_at_base: true, content: buffer.toString("utf8") });
  }

  /** @param {string} relative @param {string[]} out */
  function walk(relative, out) {
    const { absolute, exists } = resolveInside(root, relative || ".", { allowMissing: true });
    if (!exists) return;
    const stat = lstatSync(absolute);
    if (stat.isFile()) {
      out.push(relative);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.toLowerCase() === ".git")
        continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (isForbidden(child, session.forbidden_paths) || isForbidden(`${child}/`, session.forbidden_paths))
        continue;
      if (entry.isDirectory()) walk(child, out);
      else if (entry.isFile()) out.push(child);
      if (out.length > TOOL_LIMITS.maxSearchFiles)
        throw toolError("search covers too many files; narrow paths", "too_large");
    }
  }

  function search_code({ query, paths }) {
    if (typeof query !== "string" || !query || Buffer.byteLength(query) > 1000)
      throw toolError("query must be a non-empty literal string");
    const scopes = paths ?? (session.role === "reviewer" ? [""] : readableScopes);
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > TOOL_LIMITS.maxFiles)
      throw toolError("paths must list 1-20 entries");
    const files = [];
    for (const scope of scopes) {
      const relative = scope === "" ? "" : readablePath(scope).replace(/\/$/, "");
      walk(relative, files);
    }
    const results = [];
    let bytes = 0;
    for (const relative of [...new Set(files)].sort()) {
      if (deleted.has(relative)) continue;
      const absolute = path.join(root, relative);
      const stat = lstatSync(absolute);
      if (stat.size > TOOL_LIMITS.maxRangeFileBytes) continue;
      const buffer = readFileSync(absolute);
      if (looksBinary(buffer)) continue;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        const hit = { path: relative, line: index + 1, text: lines[index].slice(0, 400) };
        bytes += Buffer.byteLength(JSON.stringify(hit));
        if (results.length >= TOOL_LIMITS.maxSearchResults || bytes > TOOL_LIMITS.maxOutputBytes)
          return { results, truncated: true };
        results.push(hit);
      }
    }
    return { results, truncated: false };
  }

  function apply_patch({ edits }) {
    if (session.role !== "implementer")
      throw toolError("apply_patch is not available to the reviewer", "forbidden");
    if (!Array.isArray(edits) || !edits.length || edits.length > TOOL_LIMITS.maxEdits)
      throw toolError(`edits must list 1-${TOOL_LIMITS.maxEdits} entries`);
    /** @type {Map<string, { absolute: string, content: string | null, existed: boolean }>} */
    const files = new Map();
    // Edits apply in order, so several edits to one path compose.
    for (const [index, edit] of edits.entries()) {
      if (!isObject(edit) || typeof edit.path !== "string") throw toolError(`edit ${index} needs a path`);
      const relative = writablePath(edit.path);
      if (!files.has(relative)) {
        const { absolute, exists } = resolveInside(root, relative, { allowMissing: true });
        let content = null;
        if (exists) {
          if (!lstatSync(absolute).isFile()) throw toolError(`not a file: ${relative}`, "not_a_file");
          const buffer = readRegularFile(absolute, TOOL_LIMITS.maxPatchableFileBytes);
          if (looksBinary(buffer)) throw toolError(`cannot patch a binary file: ${relative}`, "binary");
          content = buffer.toString("utf8");
        }
        files.set(relative, { absolute, content, existed: exists });
      }
      const state = /** @type {{ absolute: string, content: string | null, existed: boolean }} */ (
        files.get(relative)
      );
      if (edit.delete === true) {
        if ("old_text" in edit || "new_text" in edit)
          throw toolError(`edit ${index}: delete takes no old_text or new_text`);
        if (state.content === null)
          throw toolError(`edit ${index}: cannot delete a missing file: ${relative}`, "not_found");
        state.content = null;
        continue;
      }
      if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string") {
        throw toolError(`edit ${index}: provide old_text and new_text, or delete: true`);
      }
      if (
        Buffer.byteLength(edit.old_text) > TOOL_LIMITS.maxPatchTextBytes ||
        Buffer.byteLength(edit.new_text) > TOOL_LIMITS.maxPatchTextBytes
      ) {
        throw toolError(
          `edit ${index}: text exceeds ${TOOL_LIMITS.maxPatchTextBytes} bytes; split the edit`,
          "too_large",
        );
      }
      if (edit.old_text === "") {
        if (state.content !== null && state.content !== "")
          throw toolError(`edit ${index}: empty old_text only creates a new or empty file: ${relative}`);
        state.content = edit.new_text;
        continue;
      }
      if (state.content === null)
        throw toolError(`edit ${index}: file does not exist: ${relative}`, "not_found");
      const first = state.content.indexOf(edit.old_text);
      if (first < 0) throw toolError(`edit ${index}: old_text not found in ${relative}`, "no_match");
      if (state.content.indexOf(edit.old_text, first + 1) >= 0)
        throw toolError(
          `edit ${index}: old_text matches more than once in ${relative}; include more context`,
          "ambiguous",
        );
      state.content =
        state.content.slice(0, first) + edit.new_text + state.content.slice(first + edit.old_text.length);
    }
    // Validate all final contents before writing or deleting any file.
    for (const [relative, state] of files) {
      if (state.content !== null && Buffer.byteLength(state.content) > TOOL_LIMITS.maxPatchableFileBytes)
        throw toolError(`${relative} would exceed the file size limit`, "too_large");
    }
    for (const [relative, state] of files) {
      if (!existingTests.has(relative) || testPolicy === "allowed") continue;
      const base = read_base_file({ path: relative }, TOOL_LIMITS.maxPatchableFileBytes);
      const classification = classifyTestFileChange(base.content, state.content);
      if (testPolicy === "new-files" || !classification.additive) {
        const affected = classification.removed_lines.slice(0, 5).map((line) => line.trim().slice(0, 200));
        throw toolError(
          `test edit policy '${testPolicy}' refuses this edit to ${relative}; base lines removed or changed: ${JSON.stringify(affected)}. Only added lines and added import names are allowed under additive policy. If the task cannot be done without changing or removing existing test lines, call submit_result with status "blocked" and name the tests and why.`,
          "test_edit_policy",
        );
      }
    }
    const changed = [];
    for (const [relative, state] of files) {
      if (state.content === null) {
        if (state.existed) {
          unlinkSync(state.absolute);
          changed.push({ path: relative, action: "deleted" });
        }
      } else {
        mkdirSync(path.dirname(state.absolute), { recursive: true });
        writeFileSync(state.absolute, state.content, { encoding: "utf8" });
        changed.push({ path: relative, action: state.existed ? "modified" : "created" });
      }
    }
    return { changed };
  }

  async function run_check({ check_id }) {
    if (session.role !== "implementer")
      throw toolError("run_check is not available to the reviewer", "forbidden");
    if (!session.run_checks.includes(check_id)) {
      throw toolError(
        `check '${check_id}' is not available; choose one of: ${session.run_checks.join(", ") || "(none)"}`,
        "unknown_check",
      );
    }
    if (runCheckCalls >= session.max_run_check_calls)
      throw toolError("run_check budget for this attempt is used up", "budget");
    runCheckCalls += 1;
    const result = await runCheck({
      check: session.project.checks[check_id],
      candidate: { root, repository_root: session.repository_root, base_commit: session.base_commit },
      config: session.project,
      backend: session.sandbox_backend,
    });
    const output = [
      result.stderr && `stderr:\n${result.stderr}`,
      result.stdout && `stdout:\n${result.stdout}`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      check_id,
      status: result.status,
      exit_code: result.exit_code,
      error: result.error,
      output: failureFirst(output, 12000),
      truncated: result.stdout_truncated || result.stderr_truncated || Buffer.byteLength(output) > 12000,
      remaining_calls: session.max_run_check_calls - runCheckCalls,
      note: "Advisory. The controller re-runs every task check on the final candidate.",
    };
  }

  function submit_result(output) {
    if (existsSync(resultFile)) throw toolError("a result was already submitted", "duplicate_result");
    const schema = loadSchema(
      session.role === "implementer" ? "implementer-output.schema.json" : "reviewer-output.schema.json",
    );
    const errors = validateAgainst(schema, output);
    if (errors.length)
      throw toolError(`result is invalid: ${errors.slice(0, 5).join("; ")}`, "invalid_result");
    writeJsonAtomic(resultFile, output);
    return { accepted: true, note: "Result recorded. Stop now." };
  }

  /** @type {Record<string, (args: any) => unknown>} */
  const handlers = { stat_paths, read_files, read_file_range, read_base_file, search_code, submit_result };
  if (session.role === "implementer") Object.assign(handlers, { apply_patch, run_check });

  /**
   * Call a tool by name. Returns `{ ok, value }` or `{ ok: false, error }`; never throws.
   * @param {string} name
   * @param {unknown} args
   */
  async function call(name, args) {
    const record = { at: new Date().toISOString(), tool: name, ok: true };
    try {
      const request = isObject(args) ? args : {};
      if (name === "read_files" || name === "stat_paths")
        Object.assign(record, { paths: tracePaths(request.paths) });
      if (name === "read_file_range" || name === "read_base_file")
        Object.assign(record, { paths: tracePaths([request.path]) });
      if (name === "search_code") {
        if (request.paths !== undefined) Object.assign(record, { paths: tracePaths(request.paths) });
        Object.assign(record, {
          query_length: typeof request.query === "string" ? request.query.length : 0,
        });
      }
      if (name === "apply_patch")
        Object.assign(record, {
          paths: tracePaths(
            Array.isArray(request.edits)
              ? request.edits.map((edit) => (isObject(edit) ? edit.path : undefined))
              : [],
          ),
        });
      if (!Object.hasOwn(handlers, name)) throw toolError(`unknown tool: ${name}`, "unknown_tool");
      if (name !== "submit_result" && calls >= session.max_tool_calls) {
        throw toolError("tool call budget exhausted; call submit_result now", "budget");
      }
      calls += 1;
      const value = await handlers[name](request);
      if (name === "apply_patch")
        Object.assign(record, {
          changed: tracePaths(/** @type {any} */ (value).changed.map((entry) => entry.path)),
        });
      if (name === "run_check")
        Object.assign(record, {
          check_id: /** @type {any} */ (args).check_id,
          status: /** @type {any} */ (value).status,
        });
      return { ok: true, value };
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : (error?.code ?? "tool_error");
      const message =
        error instanceof HarnessError ? error.message : `tool failed: ${error?.message ?? error}`;
      Object.assign(record, { ok: false, error_code: code });
      return { ok: false, error: message };
    } finally {
      appendJsonLine(traceFile, record);
    }
  }

  return { call, names: Object.keys(handlers) };
}

/** Read what a session produced. @param {string} sessionDir */
export function readSession(sessionDir) {
  const traceFile = path.join(sessionDir, "tools.jsonl");
  const resultFile = path.join(sessionDir, "result.json");
  const trace = existsSync(traceFile)
    ? readFileSync(traceFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
  return { trace, result };
}
