// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runFixers } from "../src/checks/fixers.mjs";
import { runCheck } from "../src/checks/runner.mjs";
import { initProject } from "../src/cli/init.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { makeRepo, testCandidate } from "./helpers.mjs";

const lock = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      tiny:
        specifier: 1.0.0
        version: 1.0.0
  packages/a:
    devDependencies:
      tiny:
        specifier: 1.0.0
        version: 1.0.0(peer@2.0.0)
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b
  packages/b:
    optionalDependencies:
      tiny:
        specifier: 1.0.0
        version: 1.0.0
packages:
  ignored@1.0.0:
    resolution: {integrity: ignored}
`;
const probe = [
  "node",
  "-e",
  "if(require('./packages/a/node_modules/tiny')!==42 || require('./packages/a/node_modules/b')!==7 || require('./packages/b/node_modules/tiny')!==42)process.exit(1); if(process.env.NODE_PATH!==process.cwd()+'/node_modules'||process.env.PATH.split(require('node:path').delimiter)[0]!==process.cwd()+'/node_modules/.bin')process.exit(2)",
];
/** @param {string} [lockfile] */
function fixture(lockfile = lock) {
  const definition = { run: probe, dependencies: "pnpm" };
  const raw = {
    version: 1,
    checks: { probe: definition },
    fixers: { format: { run: ["node", "format.cjs", "{files}"], dependencies: "pnpm" } },
    tests: { run_files: { run: ["node", "--test", "{files}"], dependencies: "pnpm" } },
    sandbox: { mode: "none" },
  };
  const repo = makeRepo({
    config: raw,
    files: {
      ".gitignore": "node_modules/\n",
      "pnpm-lock.yaml": lockfile,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      ".npmrc": "shared-workspace-lockfile=true\n",
      "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "biome check" } }),
      "packages/a/package.json": '{"name":"a"}',
      "packages/b/package.json": '{"name":"b","version":"1.0.0"}',
      "packages/b/index.js": "module.exports=7;",
      "test/importer.test.cjs":
        "require('node:assert/strict').equal(require('../packages/a/node_modules/tiny'),42);",
      "format.cjs":
        "const fs=require('node:fs');require('./packages/a/node_modules/tiny');fs.writeFileSync('packages/a/node_modules/cache','private');for(const f of process.argv.slice(2))fs.writeFileSync(f,'2\\n');",
    },
  });
  const store = path.join(repo.root, "node_modules/.pnpm/tiny@1.0.0/node_modules/tiny");
  mkdirSync(store, { recursive: true });
  writeFileSync(path.join(store, "package.json"), '{"name":"tiny","version":"1.0.0"}');
  writeFileSync(path.join(store, "index.js"), "module.exports=42;");
  writeFileSync(path.join(repo.root, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
  writeFileSync(path.join(repo.root, "node_modules/.pnpm/lock.yaml"), lock);
  mkdirSync(path.join(repo.root, "node_modules/.bin"));
  symlinkSync(".pnpm/tiny@1.0.0/node_modules/tiny", path.join(repo.root, "node_modules/tiny"));
  for (const importer of ["a", "b"]) {
    mkdirSync(path.join(repo.root, "packages", importer, "node_modules"));
    symlinkSync(
      "../../../node_modules/.pnpm/tiny@1.0.0/node_modules/tiny",
      path.join(repo.root, "packages", importer, "node_modules/tiny"),
    );
  }
  symlinkSync("../../b", path.join(repo.root, "packages/a/node_modules/b"));
  const candidate = testCandidate(repo.root, "main");
  const config = normalizeProjectConfig(raw, repo.root);
  return { ...repo, candidate, config, store };
}
/** @param {ReturnType<typeof fixture>} f @param {import("../src/checks/dependencies.mjs").DependencyOptions} [options] */
function run(f, options) {
  return runCheck({
    candidate: f.candidate,
    config: f.config,
    check: f.config.checks.probe,
    backend: "none",
    dependencyOptions: options,
  });
}

test("pnpm copies root and importer links, supports run_files and caches installed metadata", async () => {
  const f = fixture();
  assert.equal(f.config.fixers.format.dependencies, "pnpm");
  assert.equal(f.config.tests.run_files?.dependencies, "pnpm");
  let validations = 0;
  const options = { onValidation: () => validations++ };
  for (let i = 0; i < 2; i++) {
    const result = await run(f, options);
    assert.equal(result.status, "pass", result.error ?? result.stderr);
  }
  assert.equal(validations, 1);
  for (const name of [".modules.yaml", ".pnpm/lock.yaml"]) {
    writeFileSync(path.join(f.root, "node_modules", name), "changed");
    assert.equal((await run(f, options)).status, "pass");
  }
  assert.equal(validations, 3);
  const result = await runCheck({
    candidate: f.candidate,
    config: f.config,
    check: /** @type {import("../src/config/project.mjs").CheckDefinition} */ (f.config.tests.run_files),
    backend: "none",
    files: ["test/importer.test.cjs"],
  });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  const methods = [];
  assert.equal(
    (
      await run(f, {
        copyCommand: path.join(f.root, "missing"),
        onCopied: (method) => methods.push(method),
      })
    ).status,
    "pass",
  );
  assert.deepEqual(methods, ["fallback", "fallback", "fallback"]);
});

for (const name of [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "package.json",
  "packages/a/package.json",
  "packages/b/package.json",
]) {
  for (const checkout of ["candidate", "source"]) {
    test(`pnpm rejects ${checkout} change to ${name} with the right error class`, async () => {
      const f = fixture();
      const root = checkout === "candidate" ? f.candidate.root : f.root;
      writeFileSync(path.join(root, name), readFileSync(path.join(root, name), "utf8") + "\n");
      const result = await run(f);
      assert.equal(result.status, checkout === "candidate" ? "fail" : "infra_error");
      assert.match(result.error ?? "", /dependency_contract/);
      assert.match(result.error ?? "", checkout === "candidate" ? /base commit/ : /source checkout/);
    });
  }
}
test("pnpm rejects an input added only in the candidate", async () => {
  const f = fixture();
  // Remove from the base by using a different optional input location in a nested workspace.
  const { git } = await import("../src/util/git.mjs");
  git(f.root, ["rm", ".npmrc"]);
  git(f.root, ["commit", "-qm", "no npmrc"]);
  const candidate = testCandidate(f.root, "main");
  writeFileSync(path.join(candidate.root, ".npmrc"), "new=true");
  const result = await run({ ...f, candidate });
  assert.equal(result.status, "fail");
  assert.match(result.error ?? "", /dependency_contract/);
});
for (const problem of ["version", "name", "missing", "link"]) {
  test(`pnpm reports stale importer dependencies: ${problem}`, async () => {
    const f = fixture();
    if (problem === "version" || problem === "name")
      writeFileSync(
        path.join(f.store, "package.json"),
        JSON.stringify({
          name: problem === "name" ? "other" : "tiny",
          version: problem === "version" ? "2.0.0" : "1.0.0",
        }),
      );
    else {
      const installed = path.join(f.root, "packages/a/node_modules", problem === "link" ? "b" : "tiny");
      rmSync(installed);
      if (problem === "link") symlinkSync("../../../packages/a", installed);
    }
    const result = await run(f);
    assert.equal(result.status, "infra_error");
    assert.match(result.error ?? "", /dependencies_stale: importer .* dependency/);
  });
}
for (const absolute of [true, false]) {
  test(`pnpm rejects ${absolute ? "absolute" : "escaping"} dependency symlinks`, async () => {
    const f = fixture();
    symlinkSync(
      absolute ? f.store : path.relative(path.join(f.root, "node_modules"), path.dirname(f.root)),
      path.join(f.root, "node_modules/unsafe"),
    );
    const result = await run(f);
    assert.equal(result.status, "fail");
    assert.match(result.error ?? "", /dependency_symlink/);
  });
}
test("pnpm rejects candidate node_modules even on cached validation", async () => {
  const f = fixture();
  assert.equal((await run(f)).status, "pass");
  mkdirSync(path.join(f.candidate.root, "packages/a/node_modules"));
  writeFileSync(path.join(f.candidate.root, "packages/a/node_modules/tracked"), "candidate");
  const { git } = await import("../src/util/git.mjs");
  git(f.candidate.root, ["add", "-f", "packages/a/node_modules/tracked"]);
  const result = await run(f);
  assert.equal(result.status, "fail");
  assert.match(result.error ?? "", /dependency_contract/);
});
test("pnpm rejects a link dependency that resolves to a regular file", async () => {
  const f = fixture();
  const { git } = await import("../src/util/git.mjs");
  writeFileSync(path.join(f.root, "pnpm-lock.yaml"), lock.replace("link:../b", "link:../b/index.js"));
  git(f.root, ["add", "pnpm-lock.yaml"]);
  git(f.root, ["commit", "-qm", "link to file"]);
  const candidate = testCandidate(f.root, "main");
  const installed = path.join(f.root, "packages/a/node_modules/b");
  rmSync(installed);
  symlinkSync("../../b/index.js", installed);
  const result = await run({ ...f, candidate });
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /dependencies_stale: importer packages\/a dependency b/);
});
test("pnpm refuses unsupported lockfile versions", async () => {
  const f = fixture();
  const { git } = await import("../src/util/git.mjs");
  writeFileSync(path.join(f.root, "pnpm-lock.yaml"), lock.replace("9.0", "8.0"));
  git(f.root, ["add", "pnpm-lock.yaml"]);
  git(f.root, ["commit", "-qm", "old lock"]);
  const candidate = testCandidate(f.root, "main");
  const result = await run({ ...f, candidate });
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /dependency_contract.*unsupported lockfileVersion/);
});
test("init prefers pnpm and emits pnpm scripts and test evidence", () => {
  const f = fixture();
  initProject(f.root, { force: true });
  const config = JSON.parse(readFileSync(path.join(f.root, "apocha.config.json"), "utf8"));
  assert.deepEqual(config.checks.test.run, ["pnpm", "run", "test"]);
  assert.deepEqual(config.checks.lint.run, ["pnpm", "run", "lint"]);
  assert.equal(config.checks.test.dependencies, "pnpm");
  assert.equal(config.tests.run_files.dependencies, "pnpm");
});
test("pnpm fixers exclude every copied importer node_modules from snapshots", async () => {
  const f = fixture();
  const ctx = /** @type {any} */ ({
    candidate: f.candidate,
    config: f.config,
    sandboxBackend: "none",
    task: {
      fixers: ["format"],
      allowed_paths: ["src/"],
      protected_paths: [],
      read_only_paths: [],
      design_reference: [],
    },
    event: () => {},
  });
  const [result] = await runFixers(ctx, ["src/value.txt"]);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.changed, ["src/value.txt"]);
  assert.deepEqual(result.ignored_changes, []);
  assert.equal(readFileSync(path.join(f.candidate.root, "src/value.txt"), "utf8"), "2\n");
});

const environmentLock = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.11.2
        version: 12.11.2
packages:
  ignored@12.11.2:
    resolution: {integrity: ignored}
`;
const multidocumentLock = `${environmentLock}---\n${lock}`;

test("pnpm multidocument lock copies all importers and resolves importer-local dependencies", async () => {
  const f = fixture(multidocumentLock);
  const methods = [];
  const result = await run(f, { onCopied: (method) => methods.push(method) });
  assert.equal(result.status, "pass", result.error ?? result.stderr);
  assert.equal(methods.length, 3);
  const importerResult = await runCheck({
    candidate: f.candidate,
    config: f.config,
    check: {
      ...f.config.checks.probe,
      run: [
        "node",
        "-e",
        "process.chdir('packages/a');const localRequire=require('node:module').createRequire(process.cwd()+'/probe.cjs');require('node:assert/strict').equal(localRequire('b'),7);require('node:assert/strict').equal(localRequire('tiny'),42)",
      ],
    },
    backend: "none",
  });
  assert.equal(importerResult.status, "pass", importerResult.error ?? importerResult.stderr);
});

test("pnpm multidocument lock validates a stale dependency in a later importer", async () => {
  const f = fixture(multidocumentLock);
  rmSync(path.join(f.root, "packages/a/node_modules/tiny"));
  const result = await run(f);
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /dependencies_stale: importer packages\/a dependency tiny/);
});

test("pnpm multidocument lock refuses an unsupported version in a later document", async () => {
  const f = fixture(`${environmentLock}---\n${lock.replace("9.0", "8.0")}`);
  const result = await run(f);
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /dependency_contract.*unsupported lockfileVersion/);
});

test("pnpm multidocument lock refuses conflicting versions for a shared importer", async () => {
  const first = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      tiny:
        version: 1.0.0
`;
  const f = fixture(`${first}---\n${lock.replace("version: 1.0.0", "version: 2.0.0")}`);
  const result = await run(f);
  assert.equal(result.status, "infra_error");
  assert.match(result.error ?? "", /dependency_contract.*invalid pnpm v9 importers/);
});

for (const missing of [null, "b", "tiny"]) {
  test(`pnpm merges shared importer dependencies across documents: ${missing ?? "installed"}`, async () => {
    const first = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      b:
        version: link:packages/b
      tiny:
        version: 1.0.0
`;
    const f = fixture(`${first}---\n${lock}`);
    symlinkSync("../packages/b", path.join(f.root, "node_modules/b"));
    if (missing) rmSync(path.join(f.root, "node_modules", missing));
    const result = await run(f);
    assert.equal(result.status, missing ? "infra_error" : "pass", result.error ?? result.stderr);
    if (missing) assert.match(result.error ?? "", /dependencies_stale: importer \. dependency/);
  });
}

for (const [problem, projectLock] of [
  ["missing lockfileVersion", lock.replace("lockfileVersion: '9.0'\n", "")],
  ["unsafe importer path", lock.replace("packages/a:", "../a:")],
  ["invalid dependency name", lock.replace("      tiny:", "      ../tiny:")],
  ["missing dependency version", lock.replace("        version: 1.0.0\n", "")],
  ["duplicate importer", lock.replace("  packages/b:", "  packages/a:")],
]) {
  test(`pnpm preserves validation in later documents: ${problem}`, async () => {
    const f = fixture(`${environmentLock}---\n${projectLock}`);
    const result = await run(f);
    assert.equal(result.status, "infra_error");
    assert.match(result.error ?? "", /dependency_contract.*invalid pnpm v9 importers/);
  });
}
