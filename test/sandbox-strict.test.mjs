// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { checkDefinitionDigest, runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { bwrapArgs, detectBackend, SANDBOX_MARKER, seatbeltProfile } from "../src/sandbox/index.mjs";
import { makeRepo, testCandidate, testSocketDir, testTempDir } from "./helpers.mjs";

const available = detectBackend();
const unavailable =
  process.env[SANDBOX_MARKER] || process.env.PANAGENT_SANDBOX
    ? "already sandboxed; macOS does not support nested Seatbelt checks"
    : "required real sandbox backend is unavailable on this host";

/** @param {"seatbelt" | "bwrap"} backend @param {string} script
 * @param {{ loopback?: boolean, denyRead?: string[], run?: string[] }} [options] */
async function probe(backend, script, options = {}) {
  const repo = makeRepo({ files: { "probe.mjs": script } });
  const candidate = testCandidate(repo.root, "main");
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: {
        probe: {
          run: options.run ?? ["node", "probe.mjs"],
          loopback: options.loopback ?? false,
          timeout_ms: 10000,
        },
      },
      sandbox: { mode: "required", deny_read: options.denyRead ?? [] },
    },
    repo.root,
  );
  return runCheck({ check: config.checks.probe, candidate, config, backend });
}

/** @param {import("../src/checks/runner.mjs").CheckResult} result */
function passed(result) {
  assert.equal(result.status, "pass", result.error ?? result.stderr);
}

/** @param {net.Server} server @param {net.ListenOptions} options */
async function listen(server, options) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => resolve(undefined));
  });
}

/** @param {net.Server} server */
async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve(undefined))),
  );
}

/** @param {string} address */
function connectScript(address) {
  return `import net from "node:net";
const socket = net.connect(${address});
socket.setTimeout(2000);
socket.on("connect", () => { console.log("CONNECTED"); socket.destroy(); });
socket.on("error", () => console.log("BLOCKED"));
socket.on("timeout", () => { console.log("TIMEOUT"); socket.destroy(); });`;
}

const selfConnect = `import net from "node:net";
const server = net.createServer(socket => socket.end("pong"));
server.on("error", error => { console.error(error); process.exitCode = 1; });
server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1");
  socket.on("error", error => { console.error(error); server.close(); process.exitCode = 1; });
  socket.on("data", data => { console.log(String(data)); socket.destroy(); server.close(); });
});`;

const workspaceSocketSkip =
  "workspace Unix socket path exceeds the 100-byte safety limit (macOS sun_path: 104 bytes)";
const workspaceSocket = `import net from "node:net";
import path from "node:path";
const address = path.join(process.cwd(), "s");
if (Buffer.byteLength(address) >= 100) {
  console.log(${JSON.stringify(workspaceSocketSkip)});
  process.exit(0);
}
const server = net.createServer(socket => socket.end("pong"));
server.on("error", error => { console.error(error); process.exitCode = 1; });
server.listen(address, () => {
  const socket = net.connect(address);
  socket.on("error", error => { console.error(error); server.close(); process.exitCode = 1; });
  socket.on("data", data => { console.log(String(data)); socket.destroy(); server.close(); });
});`;

test("loopback normalization, validation and evidence are explicit", () => {
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: { off: { run: ["node"] }, on: { run: ["node"], loopback: true } },
    },
    "/",
  );
  assert.equal(config.checks.off.loopback, false);
  assert.equal(config.checks.on.loopback, true);
  assert.notEqual(checkDefinitionDigest(config.checks.off), checkDefinitionDigest(config.checks.on));
  assert.throws(() =>
    normalizeProjectConfig(
      {
        version: 1,
        checks: { bad: { run: ["node"], loopback: "true" } },
      },
      "/",
    ),
  );
  const policy = { writable: ["/workspace"], denyRead: [], network: false, cwd: "/workspace" };
  const profile = seatbeltProfile(policy);
  assert.ok(profile.startsWith("(version 1)\n(deny default)\n"));
  assert.doesNotMatch(profile, /allow default|allow ipc-posix-shm|allow network-bind\)/);
  assert.doesNotMatch(profile, /\(allow [^\n]*localhost/);
  assert.match(profile, /remote unix-socket \(path-prefix "\/workspace\/"/);
  assert.match(
    seatbeltProfile({ ...policy, loopback: true }),
    /allow network-bind network-inbound \(local ip "localhost:\*"/,
  );
  assert.deepEqual(bwrapArgs(policy, ["node"]), bwrapArgs({ ...policy, loopback: true }, ["node"]));
});

for (const backend of /** @type {const} */ (["seatbelt", "bwrap"])) {
  test(`${backend}: real sandbox default-deny probes (bubblewrap parity)`, {
    skip: available === backend ? false : unavailable,
  }, async (t) => {
    await t.test("node workspace reads and writes, npm and git execute", async () => {
      const result = await probe(
        backend,
        `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
writeFileSync("output.txt", "ok");
assert.equal(readFileSync("output.txt", "utf8"), "ok");
assert.match(readFileSync("README.md", "utf8"), /fixture/);
console.log(execFileSync("npm", ["--version"], { encoding: "utf8" }).trim());
console.log(execFileSync("git", ["--version"], { encoding: "utf8" }).trim());`,
      );
      passed(result);
      assert.match(result.stdout, /git version/);
    });
    await t.test("DNS resolution is denied", async () => {
      const result = await probe(
        backend,
        `import dns from "node:dns";
dns.lookup("example.com", error => {
  if (!error) { console.error("DNS RESOLVED"); process.exitCode = 1; }
  else console.log("BLOCKED");
});`,
      );
      passed(result);
      assert.equal(result.stdout.trim(), "BLOCKED");
    });
    await t.test("host loopback requires opt-in on Seatbelt", async () => {
      const server = net.createServer((socket) => socket.end());
      await listen(server, { host: "127.0.0.1", port: 0 });
      try {
        const port = /** @type {net.AddressInfo} */ (server.address()).port;
        for (const loopback of [false, true]) {
          const result = await probe(backend, connectScript(`{host: "127.0.0.1", port: ${port}}`), {
            loopback,
          });
          passed(result);
          // bubblewrap loopback always belongs to its own network namespace.
          assert.equal(result.stdout.trim(), backend === "seatbelt" && loopback ? "CONNECTED" : "BLOCKED");
        }
      } finally {
        await close(server);
      }
    });
    await t.test("opted-in bundler worker listens and connects to itself", async () => {
      const result = await probe(backend, selfConnect, { loopback: true });
      passed(result);
      assert.equal(result.stdout.trim(), "pong");
    });
    await t.test("outside Unix socket isolation", async () => {
      const address = path.join(testSocketDir("host.sock"), "host.sock");
      const server = net.createServer((socket) => socket.end());
      await listen(server, { path: address });
      try {
        const result = await probe(backend, connectScript(JSON.stringify(address)));
        passed(result);
        // Bubblewrap hides desktop and daemon socket directories by default.
        // Other filesystem AF_UNIX sockets, like this OS-temp fixture, stay reachable.
        // Seatbelt restricts outside sockets to checks with network access.
        assert.equal(result.stdout.trim(), backend === "seatbelt" ? "BLOCKED" : "CONNECTED");
      } finally {
        await close(server);
      }
    });
    await t.test("workspace Unix sockets work without loopback", async (t) => {
      const result = await probe(backend, workspaceSocket);
      passed(result);
      if (result.stdout.trim() === workspaceSocketSkip) {
        t.skip(workspaceSocketSkip);
        return;
      }
      assert.equal(result.stdout.trim(), "pong");
    });
    await t.test("denied directory reads and writes stay denied on both backends", async () => {
      const dir = testTempDir("denied");
      const secret = path.join(dir, "secret");
      const outside = path.join(dir, "write");
      writeFileSync(secret, "secret");
      const result = await probe(
        backend,
        `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
assert.throws(() => readFileSync(${JSON.stringify(secret)}));
assert.throws(() => writeFileSync(${JSON.stringify(outside)}, "bad"));
console.log("DENIED");`,
        { denyRead: [dir] },
      );
      passed(result);
      assert.equal(result.stdout.trim(), "DENIED");
    });
  });
}
