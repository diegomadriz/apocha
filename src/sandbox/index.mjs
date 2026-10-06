// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";
import { expandHome } from "../util/paths.mjs";

/**
 * Sandboxing for the only place untrusted code runs: checks, which execute
 * code an agent may have written. Agents themselves get no exec (they only
 * reach the harness tools), so this module is the whole OS-level boundary.
 *
 * Backends:
 * - `seatbelt` (macOS `sandbox-exec`): generated SBPL profile.
 * - `bwrap` (Linux bubblewrap): read-only root, writable exec root and scratch, optional network namespace.
 * - `none`: no OS boundary; scratch HOME/TMPDIR and the env allowlist still apply.
 *
 * Policy for every backend:
 * - writes only inside the exec root and the per-check scratch directories;
 * - reads everywhere except the deny list (credential stores, the candidate
 *   clone and source `.git` with their full history, and forbidden repo paths);
 * - no network unless the check sets `network: true` (loopback is allowed).
 */

/** @typedef {"seatbelt" | "bwrap" | "none"} SandboxBackend */

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Set in every sandboxed check's environment; a process that sees it is already confined. */
export const SANDBOX_MARKER = "APOCHA_SANDBOX";

/**
 * The OS sandbox available on this host, or null. Inside a sandboxed check
 * (for example Apocha's own test suite run as a check) nested sandboxes are
 * not possible, and the outer sandbox already confines the process.
 * @returns {SandboxBackend | null}
 */
export function detectBackend() {
  if (process.env[SANDBOX_MARKER] || process.env.PANAGENT_SANDBOX) return null;
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) return "seatbelt";
  if (process.platform === "linux") {
    const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return "bwrap";
  }
  return null;
}

/**
 * @param {"auto" | "required" | "none"} mode
 * @param {() => SandboxBackend | null} [detect]
 * @returns {SandboxBackend}
 */
export function resolveBackend(mode, detect = detectBackend) {
  if (mode === "none") return "none";
  const backend = detect();
  if (backend) return backend;
  if (mode === "required") {
    throw new HarnessError(
      "infra",
      "sandbox_unavailable",
      "sandbox.mode is 'required' but no sandbox backend is available",
    );
  }
  return "none";
}

/**
 * Absolute, existing, symlink-resolved deny paths.
 * @param {string[]} entries may start with "~/"
 */
export function resolveDenyPaths(entries) {
  const out = new Set();
  for (const entry of entries) {
    const absolute = path.resolve(expandHome(entry));
    if (!existsSync(absolute)) continue;
    out.add(absolute);
    try {
      out.add(realpathSync(absolute));
    } catch {}
  }
  return [...out].sort();
}

/**
 * Socket paths, including absent paths and existing symlink targets.
 * @param {string[]} entries
 */
export function resolveSocketPaths(entries) {
  const absolute = entries.map((entry) => path.resolve(expandHome(entry)));
  return [...new Set([...absolute, ...resolveDenyPaths(entries)])].sort();
}

/** SBPL string literal. @param {string} value */
function sbplString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean }} policy
 */
export function seatbeltProfile(policy) {
  const lines = ["(version 1)", "(allow default)"];
  if (!policy.network) {
    lines.push(
      "(deny network*)",
      '(allow network* (remote ip "localhost:*"))',
      // Bundlers such as Turbopack bind worker ports. Listening is allowed on loopback
      // addresses only, and outbound connections stay on loopback.
      "(allow network-bind)",
      '(allow network-inbound (local ip "localhost:*"))',
      "(allow network* (remote unix-socket))",
    );
  }
  for (const entry of policy.denySockets ?? []) {
    lines.push(`(deny network-outbound (remote unix-socket (path-literal ${sbplString(entry)})))`);
  }
  lines.push("(deny file-write*)");
  const writable = policy.writable.map((entry) => `(subpath ${sbplString(entry)})`);
  lines.push(
    `(allow file-write* ${[
      ...writable,
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/tty")',
      '(regex #"^/dev/fd/")',
      '(regex #"^/dev/tty")',
    ].join(" ")})`,
  );
  if (policy.denyRead.length) {
    const denied = policy.denyRead.map((entry) => {
      let isDirectory = false;
      try {
        isDirectory = statSync(entry).isDirectory();
      } catch {}
      return isDirectory ? `(subpath ${sbplString(entry)})` : `(literal ${sbplString(entry)})`;
    });
    lines.push(`(deny file-read* ${denied.join(" ")})`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean, cwd: string }} policy
 * @param {string[]} argv
 */
export function bwrapArgs(policy, argv) {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
  ];
  if (!policy.network) args.push("--unshare-net");
  for (const entry of policy.denyRead) {
    let isDirectory = false;
    try {
      isDirectory = statSync(entry).isDirectory();
    } catch {}
    if (isDirectory) args.push("--tmpfs", entry);
    else args.push("--ro-bind", "/dev/null", entry);
  }
  for (const entry of policy.writable) args.push("--bind", entry, entry);
  for (const entry of policy.denySockets ?? []) args.push("--ro-bind", "/dev/null", entry);
  args.push("--chdir", policy.cwd, "--", ...argv);
  return args;
}

/**
 * Wrap a command for the chosen backend.
 * @param {SandboxBackend} backend
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean, cwd: string }} policy
 * @param {string[]} argv
 * @returns {{ command: string, args: string[] }}
 */
export function wrapCommand(backend, policy, argv) {
  if (backend === "seatbelt")
    return { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(policy), ...argv] };
  if (backend === "bwrap") return { command: "bwrap", args: bwrapArgs(policy, argv) };
  return { command: argv[0], args: argv.slice(1) };
}
