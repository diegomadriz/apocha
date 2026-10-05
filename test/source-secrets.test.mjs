// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sourceSecretFiles } from "../src/checks/runner.mjs";
import { sourceSecretsProbe } from "../src/cli/probe.mjs";
import { wrapCommand } from "../src/sandbox/index.mjs";
import { makeRepo } from "./helpers.mjs";

test("source secret discovery includes ignored files and skips tracked and unrelated files", () => {
  const repo = makeRepo({
    files: {
      ".gitignore": "apps/web/.env.local\nignored/\n",
      ".env": "tracked",
      "tracked.pem": "tracked",
      "tracked.key": "tracked",
      id_rsa: "tracked",
      id_ed25519: "tracked",
    },
  });
  const secrets = [
    ".env.production",
    "apps/web/.env.local",
    "ignored/.env",
    "ignored/tls.pem",
    "ignored/tls.key",
    "ignored/id_rsa.backup",
    "ignored/id_ed25519",
    "keys/with space\nand newline.key",
  ];
  try {
    for (const relative of [...secrets, "notes.txt", "apps/web/env.local", "keys/key.pub"]) {
      const file = path.join(repo.root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "secret");
    }
    const files = sourceSecretFiles(repo.root);
    assert.deepEqual(files, secrets.map((relative) => path.join(repo.root, relative)).sort());
    const report = sourceSecretsProbe(repo.root);
    assert.equal(report.ok, true);
    assert.match(report.detail, /8 secret-looking untracked or ignored file\(s\)/);
    assert.match(report.detail, /sandboxed checks cannot read them/);
    assert.ok(report.detail.endsWith(JSON.stringify([...secrets].sort())));
  } finally {
    repo.cleanup();
  }
});

test("both sandbox wrappers deny an individual discovered source secret", () => {
  const repo = makeRepo();
  try {
    const secret = path.join(repo.root, ".env.local");
    writeFileSync(secret, "secret");
    const policy = {
      writable: [],
      denyRead: sourceSecretFiles(repo.root),
      network: false,
      cwd: repo.root,
    };
    const seatbelt = wrapCommand("seatbelt", policy, ["true"]);
    assert.ok(seatbelt.args[1].includes(`(deny file-read* (literal "${secret}"))`));
    const bwrap = wrapCommand("bwrap", policy, ["true"]);
    const index = bwrap.args.indexOf(secret);
    assert.deepEqual(bwrap.args.slice(index - 2, index + 1), ["--ro-bind", "/dev/null", secret]);
    assert.equal(bwrap.args.includes("--tmpfs"), false);
  } finally {
    repo.cleanup();
  }
});
