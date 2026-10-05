// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { createCandidate } from "../src/git/candidate.mjs";
import { bwrapArgs, detectBackend, resolveBackend, seatbeltProfile } from "../src/sandbox/index.mjs";
import { makeRepo } from "./helpers.mjs";

const backend = detectBackend();
const skip = backend ? false : "no sandbox backend on this host";

/**
 * Run a one-off node script as a check inside the sandbox.
 * @param {string} script
 * @param {{ network?: boolean, denyRead?: string[], sourceFiles?: Record<string, string> }} [options]
 */
async function sandboxed(script, options = {}) {
  const repo = makeRepo({ files: { "probe.mjs": script } });
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: {
        probe: {
          run: ["node", "probe.mjs", "{source}"],
          cwd: ".",
          network: options.network ?? false,
          timeout_ms: 20000,
        },
      },
      paths: { forbidden: ["private/"] },
      sandbox: { mode: "required", deny_read: options.denyRead ?? [] },
    },
    repo.root,
  );
  const candidate = createCandidate(repo.root, "main");
  try {
    for (const [relative, content] of Object.entries(options.sourceFiles ?? {}))
      writeFileSync(path.join(repo.root, relative), content);
    return await runCheck({
      check: config.checks.probe,
      candidate,
      config,
      backend: /** @type {any} */ (backend),
    });
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
}

test("resolveBackend honors the configured mode", () => {
  assert.equal(resolveBackend("none"), "none");
  assert.equal(
    resolveBackend("auto", () => null),
    "none",
  );
  assert.throws(() => resolveBackend("required", () => null), /no sandbox backend/);
  assert.equal(
    resolveBackend("required", () => "bwrap"),
    "bwrap",
  );
});

test("the seatbelt profile denies network, writes, and listed reads", () => {
  const profile = seatbeltProfile({ writable: ["/tmp/w"], denyRead: ["/etc/hosts"], network: false });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/tmp\/w"\)/);
  assert.match(profile, /\(deny file-read\* \(literal "\/etc\/hosts"\)\)/);
  assert.doesNotMatch(seatbeltProfile({ writable: [], denyRead: [], network: true }), /deny network/);
});

test("bwrap arguments isolate the network and bind only the workspace writable", () => {
  const args = bwrapArgs({ writable: ["/tmp/w"], denyRead: [], network: false, cwd: "/tmp/w/tree" }, [
    "node",
    "x.js",
  ]);
  assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
  assert.ok(args.includes("--unshare-net"));
  assert.deepEqual(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 3), [
    "--bind",
    "/tmp/w",
    "/tmp/w",
  ]);
  assert.deepEqual(args.slice(-5), ["--chdir", "/tmp/w/tree", "--", "node", "x.js"]);
  assert.ok(
    !bwrapArgs({ writable: [], denyRead: [], network: true, cwd: "/" }, ["true"]).includes("--unshare-net"),
  );
});

test("a sandboxed check runs normally inside its workspace", { skip }, async () => {
  const result = await sandboxed(
    'import { writeFileSync, readFileSync } from "node:fs"; writeFileSync("out.txt", "x"); console.log(readFileSync("README.md", "utf8").trim()); console.log(process.env.HOME.includes("panagent-check-"));',
  );
  assert.equal(result.status, "pass", result.stderr);
  assert.match(result.stdout, /# fixture\ntrue/);
  assert.equal(result.sandbox, backend);
});

test("a sandboxed check cannot read denied paths", { skip }, async () => {
  const secretDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "panagent-secret-")));
  writeFileSync(path.join(secretDir, "token"), "s3cret");
  try {
    const result = await sandboxed(
      `import { readFileSync } from "node:fs"; try { readFileSync(${JSON.stringify(path.join(secretDir, "token"))}, "utf8"); console.log("READ"); } catch (e) { console.log("DENIED", e.code); }`,
      { denyRead: [secretDir] },
    );
    assert.equal(result.status, "pass", result.stderr);
    assert.match(result.stdout, /DENIED/);
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
});

test("a sandboxed check cannot read an untracked source secret file", { skip }, async () => {
  const result = await sandboxed(
    `import { readFileSync } from "node:fs"; import path from "node:path";
try { console.log(readFileSync(path.join(process.argv[2], ".env.local"), "utf8")); }
catch { console.log("DENIED"); }`,
    { sourceFiles: { ".env.local": "source-secret" } },
  );
  assert.equal(result.status, "pass", result.stderr);
  assert.doesNotMatch(result.stdout, /source-secret/);
});

test("a sandboxed check cannot write outside its workspace", { skip }, async () => {
  const target = path.join(os.homedir(), `.panagent-sandbox-probe-${process.pid}`);
  try {
    const result = await sandboxed(
      `import { writeFileSync } from "node:fs"; try { writeFileSync(${JSON.stringify(target)}, "x"); console.log("WROTE"); } catch (e) { console.log("DENIED", e.code); }`,
    );
    assert.match(result.stdout, /DENIED/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(target, { force: true });
  }
});

test("a sandboxed check has no network unless the check allows it", { skip }, async () => {
  const script = `import net from "node:net";
const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
socket.on("connect", () => { console.log("CONNECTED"); socket.destroy(); });
socket.on("timeout", () => { console.log("BLOCKED timeout"); socket.destroy(); });
socket.on("error", (e) => console.log("BLOCKED", e.code));`;
  const denied = await sandboxed(script);
  assert.match(denied.stdout, /BLOCKED/);
  const loopback = await sandboxed(`import net from "node:net";
const server = net.createServer((s) => s.end("pong")).listen(0, "127.0.0.1", () => {
  net.connect(server.address().port, "127.0.0.1").on("data", (d) => { console.log("LOOPBACK", String(d)); server.close(); process.exit(0); });
});`);
  assert.match(loopback.stdout, /LOOPBACK pong/, loopback.stderr);
});

test("forbidden paths are not materialized for checks", { skip }, async () => {
  const result = await sandboxed(
    'import { existsSync } from "node:fs"; console.log(existsSync("private/secret.txt") ? "PRESENT" : "ABSENT");',
  );
  assert.match(result.stdout, /ABSENT/);
});

test("a check can read the source checkout but not its .git or forbidden paths", { skip }, async () => {
  const result = await sandboxed(
    `import { readFileSync } from "node:fs"; import path from "node:path"; const source = process.argv[2];
const attempt = (relative) => { try { readFileSync(path.join(source, relative)); return "read"; } catch (e) { return "denied"; } };
console.log("readme", attempt("README.md"), "git", attempt(".git/HEAD"), "private", attempt("private/secret.txt"));`,
  );
  assert.equal(result.status, "pass", result.stderr);
  assert.match(result.stdout, /readme read git denied private denied/);
});
