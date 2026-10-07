// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import {
  bwrapArgs,
  defaultSocketDirectories,
  hiddenSocketDirectories,
  seatbeltProfile,
  signingDenyPaths,
} from "../src/sandbox/index.mjs";
import { makeRepo, testCandidate, testTempDir } from "./helpers.mjs";

test("bubblewrap canonicalizes symlinked parents, omits absent paths and deduplicates deny lists", () => {
  const root = testTempDir("canonical");
  const dir = path.join(root, "real");
  const alias = path.join(root, "alias");
  mkdirSync(dir);
  symlinkSync(dir, alias);
  const file = path.join(dir, "socket");
  writeFileSync(file, "");
  const absent = path.join(alias, "absent");
  const deniedDir = path.join(dir, "denied");
  mkdirSync(deniedDir);
  const nested = path.join(deniedDir, "secret");
  writeFileSync(nested, "secret");
  const args = bwrapArgs(
    {
      writable: [],
      denyRead: [path.join(alias, "denied"), deniedDir, nested, absent],
      denySockets: [path.join(alias, "socket"), file, absent],
      network: false,
      cwd: root,
    },
    ["true"],
  );
  assert.ok(!args.includes(alias));
  assert.ok(!args.includes(path.join(alias, "socket")));
  assert.ok(!args.includes(absent));
  assert.equal(args.filter((entry) => entry === file).length, 1);
  assert.ok(!args.includes(nested));
  const index = args.indexOf(deniedDir);
  assert.deepEqual(args.slice(index - 1, index + 3), ["--tmpfs", deniedDir, "--remount-ro", deniedDir]);
  assert.equal(args.filter((entry) => entry === deniedDir).length, 2);
});

test("desktop and daemon directory defaults include session D-Bus and SSH agent locations", () => {
  assert.deepEqual(defaultSocketDirectories(123, "/agents/session/socket"), [
    "/run/user/123",
    "/tmp/.X11-unix",
    "/run/dbus",
    "/var/run/postgresql",
    "/run/mysqld",
    "/agents/session",
  ]);
  assert.equal(defaultSocketDirectories(123, "").length, 5);
});

test("hidden socket directories are existing canonical directories and never contain writable paths", () => {
  const root = testTempDir("hidden");
  const hidden = path.join(root, "agent");
  const writable = path.join(root, "workspace");
  mkdirSync(hidden);
  mkdirSync(writable);
  const alias = path.join(root, "alias");
  symlinkSync(root, alias);
  const file = path.join(root, "file");
  writeFileSync(file, "");
  assert.deepEqual(
    hiddenSocketDirectories(
      [path.join(alias, "workspace")],
      ["/", os.tmpdir(), root, alias, writable, hidden, hidden, file, path.join(root, "absent")],
    ),
    [hidden],
  );
  assert.deepEqual(hiddenSocketDirectories([hidden], [hidden]), []);
  const previous = process.env.SSH_AUTH_SOCK;
  try {
    process.env.SSH_AUTH_SOCK = path.join(hidden, "socket");
    for (const network of [false, true]) {
      const args = bwrapArgs({ writable: [writable], denyRead: [], network, cwd: root }, ["true"]);
      const index = args.indexOf(hidden);
      assert.deepEqual(args.slice(index - 1, index + 3), ["--tmpfs", hidden, "--remount-ro", hidden]);
      const excluded = bwrapArgs({ writable: [hidden], denyRead: [], network, cwd: root }, ["true"]);
      assert.ok(!excluded.some((entry, index) => entry === "--tmpfs" && excluded[index + 1] === hidden));
    }
    process.env.SSH_AUTH_SOCK = path.join(os.tmpdir(), "socket");
    assert.ok(!hiddenSocketDirectories([writable]).includes(realpathSync(os.tmpdir())));
    process.env.SSH_AUTH_SOCK = path.join(root, "socket");
    assert.ok(!hiddenSocketDirectories([writable]).includes(root));
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test("Seatbelt device write and ioctl rules allow only the controlling terminal", () => {
  for (const network of [false, true]) {
    const profile = seatbeltProfile({ writable: ["/workspace"], denyRead: [], network });
    assert.ok(profile.includes("(deny file-ioctl)"));
    assert.ok(profile.indexOf("(deny file-ioctl)") < profile.indexOf("(allow file-ioctl"));
    for (const line of profile.split("\n").filter((line) => /^\(allow file-(write\*|ioctl)/.test(line))) {
      assert.ok(line.includes('(literal "/dev/tty")'));
      assert.ok(line.includes('(literal "/dev/null")'));
      assert.ok(line.includes('(literal "/dev/zero")'));
      assert.ok(line.includes('(regex #"^/dev/fd/")'));
      assert.ok(!line.includes('(regex #"^/dev/tty'));
      assert.ok(!line.includes("/dev/(fd/|tty)"));
    }
    assert.ok(
      profile.includes('(deny file-read* file-write* (regex #"^/dev/(ttys|pty)") (literal "/dev/ptmx"))'),
    );
  }
});

test("receipt signing deny entries include both key spellings and their public keys", () => {
  const root = testTempDir("signing");
  const key = path.join(root, "credential");
  const alias = path.join(root, "receipt");
  writeFileSync(key, "private");
  writeFileSync(`${key}.pub`, "public");
  symlinkSync(key, alias);
  symlinkSync(`${key}.pub`, `${alias}.pub`);
  const denied = signingDenyPaths(alias);
  assert.deepEqual(denied, [key, `${key}.pub`, alias, `${alias}.pub`].sort());
  const profile = seatbeltProfile({ writable: [], denyRead: denied, network: false });
  for (const entry of denied) assert.ok(profile.includes(`(literal "${entry}")`));
  const args = bwrapArgs({ writable: [], denyRead: denied, network: false, cwd: root }, ["true"]);
  for (const entry of [key, `${key}.pub`]) assert.ok(args.includes(entry));
  assert.ok(!args.includes(alias));
  assert.deepEqual(signingDenyPaths(undefined), []);
});

test("runCheck distinguishes bubblewrap setup failure from a started failing check and denies signing keys", async () => {
  const root = testTempDir("fake-bwrap");
  const command = path.join(root, "bwrap");
  const log = path.join(root, "args.json");
  const key = path.join(root, "credential");
  writeFileSync(key, "private");
  writeFileSync(`${key}.pub`, "public");
  const alias = path.join(root, "receipt");
  symlinkSync(key, alias);
  symlinkSync(`${key}.pub`, `${alias}.pub`);
  writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${command}.cjs" "$@"\n`, {
    mode: 0o700,
  });
  writeFileSync(
    `${command}.cjs`,
    `const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_STARTED === "1")
  fs.writeFileSync(3, JSON.stringify({ "child-pid": 123 }) + "\\n" + JSON.stringify({ "exit-code": 1 }) + "\\n");
console.error("bwrap: Can't create file at /var/run/docker.sock");
process.exit(1);
`,
    { mode: 0o700 },
  );
  const repo = makeRepo();
  const candidate = testCandidate(repo.root, "main");
  for (const started of [false, true]) {
    const config = normalizeProjectConfig(
      {
        version: 1,
        checks: {
          probe: {
            run: ["node", "-e", "process.exit(0)"],
            env: {
              PATH: root,
              FAKE_LOG: log,
              FAKE_STARTED: started ? "1" : "0",
            },
          },
        },
        sandbox: { mode: "required" },
      },
      repo.root,
    );
    const result = await runCheck({
      check: config.checks.probe,
      candidate,
      config,
      backend: "bwrap",
      signingKey: alias,
    });
    assert.ok(result.stderr.includes("bwrap: Can't create file at /var/run/docker.sock"), result.stderr);
    assert.equal(result.status, started ? "fail" : "infra_error", result.error ?? result.stderr);
    assert.equal(result.exit_code, 1);
    assert.equal(result.error, started ? null : "bubblewrap setup failed before starting the check");
    const args = JSON.parse(readFileSync(log, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["--json-status-fd", "3"]);
    for (const entry of [key, `${key}.pub`]) assert.ok(args.includes(entry));
  }
});
