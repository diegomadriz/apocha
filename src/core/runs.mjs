// @ts-check
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";
import { appendJsonLine, writeJsonAtomic } from "../util/fs-safe.mjs";
import { gitCommonDir } from "../util/git.mjs";

/**
 * The run store keeps every run, whatever its outcome, under
 * `<git-common-dir>/panagent/runs/<run-id>/`:
 *
 * - `run.json`     metadata and current state (rewritten atomically)
 * - `events.jsonl` append-only event log; the history of every transition
 * - `report.json`  final evidence (verification, review, promotion)
 * - `sessions/<n>/` one directory per agent invocation (tool trace + result)
 *
 * Outcomes: RUNNING, PASSED, FAILED, ESCALATED, PAUSED, ERROR.
 */

export const OUTCOMES = Object.freeze(["RUNNING", "PASSED", "FAILED", "ESCALATED", "PAUSED", "ERROR"]);
export const TERMINAL = Object.freeze(new Set(["PASSED", "FAILED", "ESCALATED", "ERROR"]));

/** @param {string} repositoryRoot */
export function stateDir(repositoryRoot) {
  return path.join(gitCommonDir(repositoryRoot), "panagent");
}

/** @param {string} taskId */
export function newRunId(taskId) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${taskId}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class RunStore {
  /** @param {string} repositoryRoot */
  constructor(repositoryRoot) {
    this.root = path.join(stateDir(repositoryRoot), "runs");
  }

  /** @param {string} runId */
  dir(runId) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}-\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(runId)) {
      throw new HarnessError("config", "invalid_run_id", `invalid run id: ${runId}`);
    }
    return path.join(this.root, runId);
  }

  /**
   * @param {string} runId
   * @param {Record<string, unknown>} meta
   */
  create(runId, meta) {
    const dir = this.dir(runId);
    if (existsSync(dir)) throw new HarnessError("infra", "run_exists", `run already exists: ${runId}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = { run_id: runId, created_at: new Date().toISOString(), outcome: "RUNNING", ...meta };
    writeJsonAtomic(path.join(dir, "run.json"), record);
    return record;
  }

  /** @param {string} runId @returns {Record<string, any>} */
  read(runId) {
    const file = path.join(this.dir(runId), "run.json");
    if (!existsSync(file)) throw new HarnessError("config", "unknown_run", `unknown run: ${runId}`);
    return JSON.parse(readFileSync(file, "utf8"));
  }

  /** @param {string} runId @param {Record<string, unknown>} patch */
  update(runId, patch) {
    const next = { ...this.read(runId), ...patch, updated_at: new Date().toISOString() };
    writeJsonAtomic(path.join(this.dir(runId), "run.json"), next);
    return next;
  }

  /** @param {string} runId @param {string} type @param {Record<string, unknown>} [data] */
  event(runId, type, data = {}) {
    appendJsonLine(path.join(this.dir(runId), "events.jsonl"), {
      at: new Date().toISOString(),
      type,
      ...data,
    });
  }

  /** @param {string} runId @returns {Record<string, any>[]} */
  events(runId) {
    const file = path.join(this.dir(runId), "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** @param {string} runId @param {unknown} report */
  writeReport(runId, report) {
    writeJsonAtomic(path.join(this.dir(runId), "report.json"), report);
  }

  /** @param {string} runId @param {number} index */
  sessionDir(runId, index) {
    const dir = path.join(this.dir(runId), "sessions", String(index).padStart(3, "0"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** All runs, newest first. @returns {Record<string, any>[]} */
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => existsSync(path.join(this.root, name, "run.json")))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(path.join(this.root, name, "run.json"), "utf8"));
        } catch {
          return { run_id: name, outcome: "ERROR", unreadable: true };
        }
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /** Runs that are still RUNNING or PAUSED and name `ref` as base or batch ref. @param {string} ref */
  activeRunsNaming(ref) {
    return this.list().filter(
      (run) =>
        (run.outcome === "RUNNING" || run.outcome === "PAUSED") &&
        (run.batch_ref === ref || run.base_ref === ref),
    );
  }
}
