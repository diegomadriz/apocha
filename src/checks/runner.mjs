// @ts-check
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  resolveBackend,
  resolveDenyPaths,
  resolveSocketPaths,
  SANDBOX_MARKER,
  wrapCommand,
} from "../sandbox/index.mjs";
import { decodeCaptured } from "../util/bounded.mjs";
import { digestJson, sha256 } from "../util/digest.mjs";
import { describeError } from "../util/errors.mjs";
import { git, gitBuffer, gitCommonDir } from "../util/git.mjs";
import { canonicalPath, inAnyScope, isInside } from "../util/paths.mjs";
import { makeTempDir, removeTempDir } from "../util/temp.mjs";
import { dependencyCacheFor, prepareNpmDependencies } from "./dependencies.mjs";

/**
 * Check evidence. `status` is `pass`, `fail`, or `infra_error`; infra errors
 * always outrank a pass. Captured output is bounded, but the digests cover the
 * full streams, so evidence stays verifiable even when truncated.
 *
 * @typedef {{
 *   id: string, status: "pass" | "fail" | "infra_error" | "skipped", exit_code: number | null, error: string | null,
 *   stdout: string, stderr: string, stdout_truncated: boolean, stderr_truncated: boolean,
 *   output_digest: string, definition_digest: string, sandbox: string, duration_ms: number,
 * }} CheckResult
 */

/** @typedef {{ files: Map<string, string[]>, discover?: typeof sourceSecretFiles }} SecretFileCache */

const EMPTY = sha256(Buffer.alloc(0));
const ENV_PASSTHROUGH = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

/**
 * Untracked source files, including ignored files, with secret-looking basenames.
 * @param {string} sourceRoot
 * @returns {string[]}
 */
export function sourceSecretFiles(sourceRoot) {
  const patterns = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"];
  const listed = git(sourceRoot, [
    "ls-files",
    "--others",
    "-z",
    "--",
    ...patterns.map((pattern) => `:(top,glob)**/${pattern}`),
  ]);
  return String(listed.stdout)
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.resolve(sourceRoot, relative))
    .sort();
}

/** Digest of a check definition, recorded in receipts so a changed command is visible. @param {import("../config/project.mjs").CheckDefinition} check */
export function checkDefinitionDigest(check) {
  return digestJson({
    run: check.run,
    cwd: check.cwd,
    timeout_ms: check.timeout_ms,
    dependencies: check.dependencies,
    network: check.network,
    loopback: check.loopback,
    unsandboxed: check.unsandboxed,
    env: check.env,
  });
}

/**
 * @param {string} id
 * @param {string} definitionDigest
 * @param {string} sandbox
 * @param {string} error
 * @returns {CheckResult}
 */
function infraResult(id, definitionDigest, sandbox, error) {
  return {
    id,
    status: "infra_error",
    exit_code: null,
    error,
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    output_digest: sha256(`${EMPTY}\n${EMPTY}`),
    definition_digest: definitionDigest,
    sandbox,
    duration_ms: 0,
  };
}

/**
 * Materialize the candidate's staged index into a fresh directory: no `.git`,
 * no untracked or ignored files, and no forbidden paths.
 * @param {string} candidateRoot
 * @param {string} execRoot
 * @param {string[]} forbidden
 */
function materialize(candidateRoot, execRoot, forbidden) {
  git(candidateRoot, ["add", "--all"]);
  git(candidateRoot, ["checkout-index", "--all", "--force", `--prefix=${execRoot}${path.sep}`]);
  for (const scope of forbidden) {
    rmSync(path.join(execRoot, scope), { recursive: true, force: true });
  }
}

/**
 * Run one catalog check against the candidate's current tree.
 *
 * @param {{
 *   check: import("../config/project.mjs").CheckDefinition,
 *   candidate: { root: string, repository_root: string, base_commit: string },
 *   config: import("../config/project.mjs").ProjectConfig,
 *   backend: import("../sandbox/index.mjs").SandboxBackend,
 *   secretFileCache?: SecretFileCache,
 *   dependencyOptions?: import("./dependencies.mjs").DependencyOptions,
 *   signal?: AbortSignal,
 *   baseOverlay?: string[],
 *   baseFiles?: string[],
 *   files?: string[],
 *   maxOutputBytes?: number,
 *   onPrepared?: (root: string, excludedPaths: string[]) => void,
 *   onFinished?: (root: string, status: CheckResult["status"]) => void,
 * }} input
 * @returns {Promise<CheckResult>}
 */
export async function runCheck({
  check,
  candidate,
  config,
  backend,
  baseOverlay,
  baseFiles,
  secretFileCache,
  dependencyOptions,
  signal,
  files,
  maxOutputBytes = config.limits.check_output_bytes,
  onPrepared,
  onFinished,
}) {
  if (check.unsandboxed) backend = "none";
  const definitionDigest = checkDefinitionDigest(check);
  const started = Date.now();
  let workspace = null;
  const cleanup = () => {
    if (!workspace) return null;
    try {
      removeTempDir(workspace);
      workspace = null;
      return null;
    } catch (error) {
      return `cleanup failed: ${error.message}`;
    }
  };
  try {
    /** @type {{ command: string, args: string[], cwd: string, env: Record<string, string> }} */
    let prepared;
    try {
      if (!check.unsandboxed && backend === "none" && config.sandbox.mode === "required")
        backend = resolveBackend("required");
      workspace = makeTempDir("check", { repository: gitCommonDir(candidate.repository_root) });
      const execRoot = path.join(workspace, "tree");
      const home = path.join(workspace, "home");
      const tmp = path.join(workspace, "tmp");
      for (const dir of [execRoot, home, tmp]) mkdirSync(dir, { mode: 0o700 });
      if (baseOverlay) {
        const env = { GIT_INDEX_FILE: path.join(workspace, "base-index") };
        git(candidate.root, ["read-tree", candidate.base_commit], { env });
        git(candidate.root, ["checkout-index", "--all", "--force", `--prefix=${execRoot}${path.sep}`], {
          env,
        });
        git(candidate.root, [
          "checkout-index",
          "--force",
          `--prefix=${execRoot}${path.sep}`,
          "--",
          ...baseOverlay,
        ]);
        for (const scope of config.paths.forbidden)
          rmSync(path.join(execRoot, scope), { recursive: true, force: true });
      } else {
        materialize(candidate.root, execRoot, config.paths.forbidden);
      }
      for (const file of baseFiles ?? []) {
        canonicalPath(file, "baseFiles");
        if (inAnyScope(file, config.paths.forbidden)) throw new Error(`base file is forbidden: ${file}`);
        const target = path.resolve(execRoot, file);
        if (!isInside(target, execRoot)) throw new Error("base file escapes the tree");
        const contents = gitBuffer(candidate.root, ["show", `${candidate.base_commit}:${file}`]);
        mkdirSync(path.dirname(target), { recursive: true });
        rmSync(target, { force: true });
        writeFileSync(target, contents);
      }
      const cwd = check.cwd === "." ? execRoot : path.resolve(execRoot, check.cwd);
      if (!isInside(cwd, execRoot))
        return infraResult(check.id, definitionDigest, backend, "check cwd escapes the tree");
      mkdirSync(cwd, { recursive: true });

      const sourceRoot = realpathSync(candidate.repository_root);
      let extraPath = [];
      let nodePath = null;
      let sourceBin = null;
      if (check.dependencies === "npm") {
        const deps = prepareNpmDependencies({
          candidateRoot: candidate.root,
          sourceRoot,
          baseCommit: candidate.base_commit,
          cwd: check.cwd,
          execCwd: cwd,
          options: { cache: dependencyCacheFor(candidate), ...dependencyOptions },
        });
        extraPath = [path.join(deps.node_modules, ".bin")];
        nodePath = deps.node_modules;
        sourceBin = deps.source_bin;
      }
      const hostPath = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => entry && !(sourceBin && path.resolve(entry) === sourceBin));
      /** @type {Record<string, string>} */
      const env = {};
      for (const key of ENV_PASSTHROUGH)
        if (process.env[key] !== undefined) env[key] = /** @type {string} */ (process.env[key]);
      Object.assign(env, {
        PATH: [...extraPath, ...hostPath].join(path.delimiter),
        HOME: home,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        CI: "1",
        ...(backend === "none" ? {} : { [SANDBOX_MARKER]: backend }),
        ...(nodePath ? { NODE_PATH: nodePath } : {}),
        ...check.env,
      });
      if (check.unsandboxed) {
        delete env[SANDBOX_MARKER];
        delete env.PANAGENT_SANDBOX;
      }
      // Older repository commits use the pre-rename marker to avoid nested sandboxes.
      if (env[SANDBOX_MARKER]) env.PANAGENT_SANDBOX = env[SANDBOX_MARKER];
      const argv = check.run.flatMap((part) =>
        part === "{files}" && files ? files : [part.replaceAll("{source}", sourceRoot)],
      );
      const commonDir = realpathSync(gitCommonDir(sourceRoot));
      let secrets = secretFileCache?.files.get(sourceRoot);
      if (!secrets) {
        secrets = (secretFileCache?.discover ?? sourceSecretFiles)(sourceRoot);
        secretFileCache?.files.set(sourceRoot, secrets);
      }
      const denyRead = resolveDenyPaths([
        ...config.sandbox.deny_read,
        ...secrets,
        realpathSync(candidate.root),
        commonDir,
        path.join(sourceRoot, ".git"),
        ...config.paths.forbidden.map((scope) => path.join(sourceRoot, scope)),
      ]).filter((entry) => !isInside(workspace, entry));
      const network = check.network || config.sandbox.network === "allow";
      const denySockets = (backend === "bwrap" ? resolveDenyPaths : resolveSocketPaths)(
        config.sandbox.deny_sockets,
      );
      const wrapped = wrapCommand(
        backend,
        { writable: [workspace], denyRead, denySockets, network, loopback: check.loopback, cwd },
        argv,
      );
      prepared = { ...wrapped, cwd, env };
      onPrepared?.(execRoot, [home, tmp, ...(nodePath ? [nodePath] : [])]);
    } catch (error) {
      const cleanupError = cleanup();
      const detail = describeError(error);
      const status = detail.error_class === "integrity" ? "fail" : "infra_error";
      const result = infraResult(
        check.id,
        definitionDigest,
        backend,
        cleanupError ?? `${detail.code}: ${detail.message}`,
      );
      return { ...result, status, duration_ms: Date.now() - started };
    }

    return await new Promise((resolve) => {
      const capture = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const bytes = { stdout: 0, stderr: 0 };
      const hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") };
      let settled = false;
      let timedOut = false;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const finish = (
        /** @type {{ status: CheckResult["status"], exit_code: number | null, error: string | null }} */ outcome,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        try {
          if (workspace) onFinished?.(path.join(workspace, "tree"), outcome.status);
        } catch (error) {
          outcome = { status: "infra_error", exit_code: outcome.exit_code, error: error.message };
        }
        const cleanupError = cleanup();
        if (cleanupError)
          outcome = { status: "infra_error", exit_code: outcome.exit_code, error: cleanupError };
        const stdoutDigest = hashes.stdout.digest("hex");
        const stderrDigest = hashes.stderr.digest("hex");
        const stdout = decodeCaptured(capture.stdout);
        const stderr = decodeCaptured(capture.stderr);
        resolve({
          id: check.id,
          ...outcome,
          stdout,
          stderr,
          stdout_truncated: bytes.stdout > Buffer.byteLength(stdout),
          stderr_truncated: bytes.stderr > Buffer.byteLength(stderr),
          output_digest: sha256(`${stdoutDigest}\n${stderrDigest}`),
          definition_digest: definitionDigest,
          sandbox: backend,
          duration_ms: Date.now() - started,
        });
      };
      const collect = (/** @type {"stdout" | "stderr"} */ stream, /** @type {Buffer} */ chunk) => {
        hashes[stream].update(chunk);
        bytes[stream] += chunk.length;
        const room = maxOutputBytes - capture[stream].length;
        if (room > 0) capture[stream] = Buffer.concat([capture[stream], chunk.subarray(0, room)]);
      };
      let child;
      const abort = () => {
        try {
          process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      if (signal?.aborted) {
        finish({ status: "infra_error", exit_code: null, error: "aborted" });
        return;
      }
      try {
        child = spawn(prepared.command, prepared.args, {
          cwd: prepared.cwd,
          env: prepared.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        finish({
          status: "infra_error",
          exit_code: null,
          error: `spawn failed: ${error.code ?? error.message}`,
        });
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, check.timeout_ms);
      child.on("error", (error) =>
        finish({
          status: "infra_error",
          exit_code: null,
          error: `spawn failed: ${/** @type {any} */ (error).code ?? error.message}`,
        }),
      );
      child.on("close", (code, signal) => {
        if (timedOut) finish({ status: "infra_error", exit_code: code, error: "timeout" });
        else if (signal) finish({ status: "infra_error", exit_code: code, error: `signal ${signal}` });
        else finish({ status: code === 0 ? "pass" : "fail", exit_code: code, error: null });
      });
    });
  } finally {
    if (workspace) removeTempDir(workspace);
  }
}
