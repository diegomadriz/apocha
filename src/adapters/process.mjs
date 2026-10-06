// @ts-check
import { spawn, spawnSync } from "node:child_process";
import { utf8Suffix } from "../util/bounded.mjs";
import { HarnessError } from "../util/errors.mjs";

/**
 * Spawn an agent runtime, feed it a prompt on stdin, and stream its stdout as
 * JSON lines to `onEvent`. `onEvent` may throw a HarnessError (for example a
 * policy violation); the process is then killed and the error rethrown.
 *
 * @param {{
 *   command: string, args: string[], cwd: string, env: Record<string, string>,
 *   input: string, timeoutMs: number, signal?: AbortSignal,
 *   onEvent: (event: any) => void,
 * }} options
 * @returns {Promise<{ code: number | null, signal: string | null, stderrTail: string, nonJsonLines: number }>}
 */
export function runJsonlProcess(options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new HarnessError("infra", "aborted", "run aborted"));
      return;
    }
    let child;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      reject(new HarnessError("infra", "spawn_failed", `cannot start ${options.command}: ${error.message}`));
      return;
    }
    let buffer = "";
    let stderr = "";
    let nonJsonLines = 0;
    /** @type {HarnessError | null} */
    let failure = null;
    let settled = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      failure =
        failure ??
        new HarnessError("infra", "timeout", `${options.command} exceeded ${options.timeoutMs} ms`);
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      failure = failure ?? new HarnessError("infra", "aborted", "run aborted");
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line) => {
      const text = line.replace(/\r$/, "");
      if (!text.trim() || failure) return;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        nonJsonLines += 1;
        return;
      }
      try {
        options.onEvent(event);
      } catch (error) {
        failure =
          error instanceof HarnessError
            ? error
            : new HarnessError("infra", "event_handler", String(error?.message ?? error));
        kill();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = utf8Suffix(stderr + chunk, 8000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    const done = (/** @type {number | null} */ code, /** @type {string | null} */ sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (buffer) handleLine(buffer);
      if (failure) reject(failure);
      else resolve({ code, signal: sig, stderrTail: stderr, nonJsonLines });
    };
    child.on("error", (error) => {
      failure =
        failure ??
        new HarnessError("infra", "spawn_failed", `cannot start ${options.command}: ${error.message}`);
      done(null, null);
    });
    child.on("close", done);
  });
}

/**
 * Read a CLI's version (first x.y.z in `--version` output).
 * @param {string} command
 * @returns {string | null}
 */
export function cliVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(`${result.stdout}${result.stderr}`)?.[1] ?? null;
}

/** @param {string} a @param {string} b @returns {number} */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Classify provider error text. Usage and rate limits pause the run instead of failing it.
 * @param {string} message
 * @returns {{ errorClass: "usage_limited" | "provider", retryAfter: string | null }}
 */
export function classifyProviderMessage(message) {
  const text = String(message ?? "");
  if (
    /usage limit|rate limit|rate_limit|quota|too many requests|\b429\b|limit (?:has been )?reached|hit your limit|try again (?:at|in)/i.test(
      text,
    )
  ) {
    const at =
      /try again at ([^.\n]+)/i.exec(text)?.[1] ?? /resets? (?:at|on) ([^.\n]+)/i.exec(text)?.[1] ?? null;
    return { errorClass: "usage_limited", retryAfter: at ? at.trim().slice(0, 100) : null };
  }
  return { errorClass: "provider", retryAfter: null };
}

/** Minimal environment for an agent runtime: no repository secrets, but the runtime's own auth. */
export function runtimeEnvironment(extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "SHELL",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
  ]) {
    if (process.env[key] !== undefined) env[key] = /** @type {string} */ (process.env[key]);
  }
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_|AZURE_OPENAI_|GEMINI_|GOOGLE_API_KEY$|PI_)/.test(key))
      env[key] = /** @type {string} */ (process.env[key]);
  }
  return { ...env, ...extra };
}
