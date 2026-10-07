// @ts-check
import assert from "node:assert/strict";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCheck, sourceSecretFiles } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { initialState } from "../src/core/context.mjs";
import {
  bwrapArgs,
  canonicalDenyPaths,
  detectBackend,
  resolveDenyPaths,
  resolveSocketPaths,
  seatbeltProfile,
} from "../src/sandbox/index.mjs";
import { runChecksStage } from "../src/stages/checks.mjs";
import { makeRepo, testCandidate, testSocketDir, testTempDir } from "./helpers.mjs";

test("socket defaults and additions appear in both backend policies", () => {
  const defaults = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "~/.docker/run/docker.sock",
    "~/.colima/default/docker.sock",
    "~/.orbstack/run/docker.sock",
    "/run/containerd/containerd.sock",
    "/run/podman/podman.sock",
    "~/.local/share/containers/podman/machine/podman.sock",
  ];
  const config = normalizeProjectConfig(
    { version: 1, checks: {}, sandbox: { deny_sockets: ["/tmp/custom.sock"] } },
    "/",
  );
  assert.deepEqual(config.sandbox.deny_sockets, [...defaults, "/tmp/custom.sock"]);
  const denySockets = resolveSocketPaths(config.sandbox.deny_sockets);
  for (const entry of defaults) {
    const expanded = entry.startsWith("~/") ? path.join(os.homedir(), entry.slice(2)) : entry;
    assert.ok(denySockets.includes(expanded));
  }
  for (const network of [false, true]) {
    const policy = { writable: [], denyRead: [], denySockets, network, cwd: "/" };
    const profile = seatbeltProfile(policy);
    const args = bwrapArgs(policy, ["true"]);
    for (const entry of denySockets) {
      const rule = `(deny network-outbound (remote unix-socket (path-literal "${entry}")))`;
      assert.ok(profile.includes(rule), profile);
      const orderingProfile = seatbeltProfile({
        ...policy,
        network: false,
        writable: ["/workspace", "/scratch"],
      });
      const workspaceAllows = [
        ...orderingProfile.matchAll(/\(allow [^\n]*unix-socket \(path-prefix [^\n]+/g),
      ];
      assert.equal(workspaceAllows.length, 4, orderingProfile);
      for (const deny of [rule, `(deny file-read* (literal "${entry}"))`])
        assert.ok(
          workspaceAllows.every((allow) => orderingProfile.indexOf(deny) > allow.index),
          orderingProfile,
        );
      const canonical = canonicalDenyPaths([entry])[0];
      if (canonical) {
        const index = args.indexOf(canonical);
        assert.deepEqual(args.slice(index - 2, index + 1), ["--ro-bind", "/dev/null", canonical]);
      } else assert.ok(!args.includes(entry));
    }
  }
});

test("a real sandbox blocks a listed Unix socket but allows the same socket otherwise", {
  skip: detectBackend()
    ? false
    : "no sandbox backend available; real Unix socket enforcement requires Seatbelt or bubblewrap",
}, async () => {
  const backend = /** @type {"seatbelt" | "bwrap"} */ (detectBackend());
  const dir = testSocketDir("daemon.sock");
  const socketPath = path.join(dir, "daemon.sock");
  const alias = path.join(dir, "alias.sock");
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  symlinkSync(socketPath, alias);
  const repo = makeRepo();
  const candidate = testCandidate(repo.root, "main");
  try {
    assert.ok(resolveSocketPaths([alias]).includes(realpathSync(socketPath)));
    assert.ok(resolveDenyPaths([alias]).includes(socketPath));
    const script = `const net = require("node:net");
const socket = net.connect(${JSON.stringify(socketPath)});
socket.setTimeout(3000);
socket.on("connect", () => { console.log("CONNECTED"); socket.destroy(); });
socket.on("error", () => { console.log("DENIED"); process.exitCode = 1; });
socket.on("timeout", () => { console.log("TIMEOUT"); socket.destroy(); process.exitCode = 2; });`;
    // Outside-workspace sockets require network access under the strict Seatbelt policy.
    for (const network of [false, true]) {
      for (const denied of [false, true]) {
        const config = normalizeProjectConfig(
          {
            version: 1,
            checks: { probe: { run: ["node", "-e", script], network: denied ? network : true } },
            sandbox: { mode: "required", deny_sockets: denied ? [alias] : [] },
          },
          repo.root,
        );
        const result = await runCheck({ check: config.checks.probe, candidate, config, backend });
        assert.equal(result.status, denied ? "fail" : "pass", result.stderr);
        assert.equal(result.stdout.trim(), denied ? "DENIED" : "CONNECTED", result.stderr);
      }
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  }
});

test("a run discovers source secrets once across several checks and repair attempts", async () => {
  const repo = makeRepo();
  const candidate = testCandidate(repo.root, "main");
  writeFileSync(path.join(repo.root, ".env.local"), "secret");
  writeFileSync(path.join(repo.root, "src", "token.key"), "key");
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: {
        first: { run: ["node", "-e", "process.exit(0)"] },
        second: { run: ["node", "-e", "process.exit(0)"] },
      },
    },
    repo.root,
  );
  let discoveries = 0;
  const cache = {
    files: new Map(),
    discover: (/** @type {string} */ root) => {
      discoveries++;
      return sourceSecretFiles(root);
    },
  };
  const ctx = /** @type {any} */ ({
    candidate,
    config,
    sandboxBackend: "none",
    secretFileCache: cache,
    task: {
      allowed_paths: ["src/"],
      protected_paths: [],
      design_reference: [],
      checks: ["first", "second"],
      test_edits: "additive",
    },
    governance: { edits_allowed: false },
    state: initialState("checks"),
    runId: "fixture",
    store: { dir: () => testTempDir("verification") },
    event: () => {},
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.state.attempt = attempt;
    assert.equal(await runChecksStage(/** @type {any} */ (null), ctx), "pass");
  }
  assert.equal(discoveries, 1);
  assert.deepEqual(cache.files.get(realpathSync(repo.root)), [
    path.join(repo.root, ".env.local"),
    path.join(repo.root, "src", "token.key"),
  ]);
  const other = makeRepo();
  const otherCandidate = testCandidate(other.root, "main");
  const result = await runCheck({
    check: config.checks.first,
    candidate: otherCandidate,
    config,
    backend: "none",
    secretFileCache: cache,
  });
  assert.equal(result.status, "pass", result.stderr);
  assert.equal(discoveries, 2);
  assert.deepEqual(cache.files.get(realpathSync(other.root)), []);
});
