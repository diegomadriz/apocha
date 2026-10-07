// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";
import { expandHome, isInside } from "../util/paths.mjs";

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
 * - no network unless allowed; Seatbelt loopback requires `loopback: true`.
 *   Workspace Unix sockets and bubblewrap namespace loopback support local IPC.
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

/**
 * Only existing canonical mount targets work with older bubblewrap versions.
 * @param {string[]} entries
 */
export function canonicalDenyPaths(entries) {
  const out = new Set();
  for (const entry of entries) {
    try {
      out.add(realpathSync(path.resolve(expandHome(entry))));
    } catch {}
  }
  return [...out].sort();
}

/** @param {string | undefined} key */
export function signingDenyPaths(key) {
  return key ? resolveSocketPaths([key, `${key}.pub`]) : [];
}

/** @param {number} [uid] @param {string | undefined} [sshAuthSock] */
export function defaultSocketDirectories(
  uid = process.getuid?.() ?? 0,
  sshAuthSock = process.env.SSH_AUTH_SOCK,
) {
  return [
    `/run/user/${uid}`,
    "/tmp/.X11-unix",
    "/run/dbus",
    "/var/run/postgresql",
    "/run/mysqld",
    ...(sshAuthSock ? [path.dirname(path.resolve(sshAuthSock))] : []),
  ];
}

/**
 * Never cover the workspace, root, or the OS temporary directory.
 * @param {string[]} writable
 * @param {string[]} [entries]
 */
export function hiddenSocketDirectories(writable, entries = defaultSocketDirectories()) {
  const temp = realpathSync(os.tmpdir());
  const writes = writable.map((entry) => {
    try {
      return realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  });
  return canonicalDenyPaths(entries).filter(
    (entry) =>
      entry !== "/" &&
      entry !== temp &&
      !writes.some((write) => isInside(write, entry)) &&
      statSync(entry).isDirectory(),
  );
}

/** SBPL string literal. @param {string} value */
function sbplString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean, loopback?: boolean }} policy
 */
export function seatbeltProfile(policy) {
  const lines = ["(version 1)", policy.network ? "(allow default)" : "(deny default)"];
  if (!policy.network) {
    lines.push(
      "; Process execution for toolchains at arbitrary paths and their child processes.",
      "(allow process-fork process-exec)",
      "; Signals stay within this sandbox; runtime introspection stays on self.",
      "(allow signal (target same-sandbox))",
      "(allow process-info* (target self))",
      "; CPU, memory and platform discovery by libc, node and python.",
      "(allow sysctl-read)",
      "; Toolchains and shared libraries can be anywhere on the read-only host view.",
      "(allow file-read*)",
      "; libc logging, notifications and user/group lookups; no general Mach access.",
      '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.notifyd") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))',
      "; Block DNS and network configuration brokers as well as direct network access.",
      '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.NetworkConfiguration"))',
      "(deny network*)",
    );
    for (const entry of policy.writable) {
      const prefix = sbplString(`${entry.endsWith("/") ? entry.slice(0, -1) : entry}/`);
      lines.push(
        "; Workspace Unix sockets provide IPC for tools without reaching host daemons.",
        `(allow network* (remote unix-socket (path-prefix ${prefix})))`,
        `(allow network-bind network-inbound (local unix-socket (path-prefix ${prefix})))`,
      );
    }
    if (policy.loopback) {
      lines.push(
        "; Explicit per-check loopback access for bundler workers and local test servers.",
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-bind network-inbound (local ip "localhost:*"))',
      );
    }
  }
  for (const entry of policy.denySockets ?? []) {
    lines.push(
      "; Listed daemon sockets remain inaccessible after every network allow.",
      `(deny network-outbound (remote unix-socket (path-literal ${sbplString(entry)})))`,
      `(deny file-read* (literal ${sbplString(entry)}))`,
    );
  }
  lines.push("; Writes are confined to scratch space and standard device streams.", "(deny file-write*)");
  const writable = policy.writable.map((entry) => `(subpath ${sbplString(entry)})`);
  lines.push(
    `(allow file-write* ${[
      ...writable,
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/tty")',
      '(regex #"^/dev/fd/")',
    ].join(" ")})`,
  );
  lines.push("; Terminal and descriptor controls used by command-line tools.", "(deny file-ioctl)");
  lines.push(
    `(allow file-ioctl ${writable
      .concat([
        '(literal "/dev/null")',
        '(literal "/dev/zero")',
        '(literal "/dev/tty")',
        '(regex #"^/dev/fd/")',
      ])
      .join(" ")})`,
  );
  lines.push(
    "; Other terminals and pseudo-terminals cannot be opened.",
    '(deny file-read* file-write* (regex #"^/dev/(ttys|pty)") (literal "/dev/ptmx"))',
  );
  if (policy.denyRead.length) {
    const denied = policy.denyRead.map((entry) => {
      let isDirectory = false;
      try {
        isDirectory = statSync(entry).isDirectory();
      } catch {}
      return isDirectory ? `(subpath ${sbplString(entry)})` : `(literal ${sbplString(entry)})`;
    });
    lines.push("; Credentials, source history and forbidden paths override broad reads.");
    lines.push(`(deny file-read* ${denied.join(" ")})`);
  }
  lines.push(
    "; Metadata is available everywhere for toolchain path discovery.",
    "(allow file-read-metadata)",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean, loopback?: boolean, cwd: string }} policy
 * @param {string[]} argv
 * @param {string[]} [socketDirectories]
 */
export function bwrapArgs(policy, argv, socketDirectories = hiddenSocketDirectories(policy.writable)) {
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
  const denied = canonicalDenyPaths([
    ...policy.denyRead,
    ...(policy.denySockets ?? []),
    ...socketDirectories,
  ]);
  // A hidden parent already covers its children; mounting them would require
  // creating targets inside the parent's read-only tmpfs.
  const directories = denied.filter((entry) => statSync(entry).isDirectory());
  for (const entry of denied) {
    if (directories.some((parent) => parent !== entry && isInside(entry, parent))) continue;
    if (statSync(entry).isDirectory()) args.push("--tmpfs", entry, "--remount-ro", entry);
    else args.push("--ro-bind", "/dev/null", entry);
  }
  for (const entry of policy.writable) args.push("--bind", entry, entry);
  args.push("--chdir", policy.cwd, "--", ...argv);
  return args;
}

/**
 * Wrap a command for the chosen backend.
 * @param {SandboxBackend} backend
 * @param {{ writable: string[], denyRead: string[], denySockets?: string[], network: boolean, loopback?: boolean, cwd: string }} policy
 * @param {string[]} argv
 * @returns {{ command: string, args: string[] }}
 */
export function wrapCommand(backend, policy, argv) {
  if (backend === "seatbelt")
    return { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(policy), ...argv] };
  if (backend === "bwrap") return { command: "bwrap", args: bwrapArgs(policy, argv) };
  return { command: argv[0], args: argv.slice(1) };
}
