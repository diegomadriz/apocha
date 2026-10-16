// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { homeReadAllowList } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { seatbeltProfile } from "../src/sandbox/index.mjs";
import { testTempDir } from "./helpers.mjs";

function fixture() {
  const root = testTempDir("home-allow");
  const hostHome = path.join(root, "home");
  mkdirSync(path.join(hostHome, "bin"), { recursive: true });
  const execPath = path.join(hostHome, "bin/node");
  writeFileSync(execPath, "");
  return {
    hostHome,
    workspace: root,
    sourceRoot: root,
    execPath,
    pathEntries: [],
    browser: false,
    allowRead: [],
  };
}

test("PATH home/bin allows bin without reopening home", () => {
  const input = fixture();
  const bin = path.join(input.hostHome, "bin");
  assert.deepEqual(homeReadAllowList({ ...input, pathEntries: [bin] }), [bin]);
});

test("allow_read home, tilde and symlinks to home never reopen home", () => {
  const input = fixture();
  const link = path.join(input.workspace, "home-link");
  symlinkSync(input.hostHome, link, "dir");
  assert.deepEqual(
    homeReadAllowList({
      ...input,
      allowRead: ["~", input.hostHome, link],
    }),
    [],
  );
});

test("Node installed at home/bin/node does not allow its home prefix", () => {
  assert.deepEqual(homeReadAllowList(fixture()), []);
});

test("every allow source rejects home, outside paths and missing paths after realpath", () => {
  const input = fixture();
  const outside = path.join(input.workspace, "outside");
  mkdirSync(path.join(outside, "bin"), { recursive: true });
  writeFileSync(path.join(outside, "bin/node"), "");
  const outsideLink = path.join(input.hostHome, "outsideLink");
  symlinkSync(outside, outsideLink, "dir");
  for (const entry of [input.hostHome, outside, outsideLink, path.join(input.hostHome, "missing")]) {
    assert.deepEqual(
      homeReadAllowList({
        ...input,
        workspace: entry,
        sourceRoot: entry,
        corepackHome: entry,
        execPath: path.join(entry, "bin/node"),
        pathEntries: [entry],
        allowRead: [entry],
      }),
      [],
    );
  }
  const cache = path.join(input.hostHome, "Library/Caches");
  mkdirSync(cache, { recursive: true });
  symlinkSync(outside, path.join(cache, "ms-playwright"), "dir");
  assert.deepEqual(homeReadAllowList({ ...input, browser: true }), []);
});

test("existing workspace, source, Node, PATH, corepack, browser and explicit home paths are allowed", () => {
  const input = fixture();
  const names = [
    "workspace",
    "source",
    "node/bin",
    "tools/bin",
    "corepack",
    "Library/Caches/ms-playwright",
    "explicit",
  ];
  for (const name of names) mkdirSync(path.join(input.hostHome, name), { recursive: true });
  const execPath = path.join(input.hostHome, "node/bin/node");
  writeFileSync(execPath, "");
  const link = path.join(input.hostHome, "explicit-link");
  symlinkSync(path.join(input.hostHome, "explicit"), link, "dir");
  const allowed = homeReadAllowList({
    ...input,
    workspace: path.join(input.hostHome, "workspace"),
    sourceRoot: path.join(input.hostHome, "source"),
    execPath,
    pathEntries: [path.join(input.hostHome, "tools/bin"), execPath, ""],
    corepackHome: "~/corepack",
    browser: true,
    allowRead: ["~/explicit", link],
  });
  assert.deepEqual(
    allowed,
    [
      "workspace",
      "source",
      "node",
      "tools/bin",
      "tools",
      "corepack",
      "Library/Caches/ms-playwright",
      "explicit",
    ].map((name) => realpathSync(path.join(input.hostHome, name))),
  );
});

test("cargo parent is allowed but credential denies follow all home allows", () => {
  const input = fixture();
  const cargo = path.join(input.hostHome, ".cargo");
  mkdirSync(path.join(cargo, "bin"), { recursive: true });
  const allowRead = homeReadAllowList({
    ...input,
    pathEntries: [path.join(input.hostHome, "bin"), path.join(cargo, "bin")],
    allowRead: ["~"],
  });
  assert.ok(allowRead.includes(cargo));
  const config = normalizeProjectConfig({ version: 1, checks: { probe: { run: ["node"] } } }, "/");
  const credentials = [
    "~/.cargo/credentials",
    "~/.cargo/credentials.toml",
    "~/.gem/credentials",
    "~/.gradle/gradle.properties",
    "~/.m2/settings.xml",
    "~/.m2/settings-security.xml",
    "~/.terraform.d/credentials.tfrc.json",
    "~/.vault-token",
    "~/.password-store",
    "~/.local/share/keyrings",
    "~/.config/op",
    "~/.pub-cache/credentials.json",
  ];
  for (const entry of credentials) assert.ok(config.sandbox.deny_read.includes(entry), entry);
  const denyRead = config.sandbox.deny_read.map((entry) => path.join(input.hostHome, entry.slice(2)));
  const profile = seatbeltProfile({
    writable: [],
    network: false,
    denyReadTrees: [input.hostHome],
    allowRead,
    denyRead,
  });
  const lines = profile.trim().split("\n");
  assert.ok(!lines.includes(`(allow file-read* (subpath ${JSON.stringify(input.hostHome)}))`));
  const lastAllow = lines.findLastIndex((line) => line.startsWith("(allow file-read* ("));
  const homeDeny = lines.indexOf(`(deny file-read* (subpath ${JSON.stringify(input.hostHome)}))`);
  assert.ok(homeDeny >= 0 && homeDeny < lastAllow);
  for (const entry of credentials) {
    const resolved = path.join(input.hostHome, entry.slice(2));
    const deny = lines.findIndex(
      (line) =>
        line.startsWith("(deny file-read* ") && line.includes(`(literal ${JSON.stringify(resolved)})`),
    );
    assert.ok(deny > lastAllow, entry);
  }
});
