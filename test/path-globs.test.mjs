// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canRunTestPath,
  isTestPath,
  loadProjectConfig,
  normalizeProjectConfig,
  selectChecks,
} from "../src/config/project.mjs";
import { makeRepo, valueTask } from "./helpers.mjs";

/** @param {string} field @param {string[]} paths */
function rawConfig(field, paths) {
  return {
    version: 1,
    checks: { ok: { run: ["node", "--version"] } },
    ...(field === "check_selection[0].paths"
      ? { check_selection: [{ paths, checks: ["ok"] }] }
      : {
          tests: {
            ...(field === "tests.paths" ? { paths } : {}),
            run_files: {
              run: ["node", "--test", "{files}"],
              ...(field === "tests.run_files.paths" ? { paths } : {}),
            },
          },
        }),
  };
}

const fields = ["check_selection[0].paths", "tests.paths", "tests.run_files.paths"];
for (const field of fields) {
  test(`${field} uses the shared path-pattern syntax and preserves literal scopes`, () => {
    const cases = [
      {
        entry: "pkg/src/export*.ts",
        yes: ["pkg/src/export-sync.ts", "pkg/src/export.ts"],
        no: ["pkg/src/sub/export.ts", "pkg/export.ts", "pkg/src/export-syncXts"],
      },
      { entry: "*.sql", yes: ["db/m/001.sql", "001.sql"], no: ["db/m/001.sql.bak", "db/m/001Xsql"] },
      { entry: "src/*.test.ts", yes: ["src/a.test.ts"], no: ["src/x/a.test.ts", "a.test.ts"] },
      { entry: "src/", yes: ["src/a.ts", "src/x/a.ts"], no: ["src-other/a.ts", "other/src/a.ts"] },
      { entry: "qa/check.mjs", yes: ["qa/check.mjs"], no: ["other/qa/check.mjs", "qa/check.mjs.bak"] },
      { entry: "check.mjs", yes: ["check.mjs"], no: ["qa/check.mjs"] },
      { entry: "src/a+b(*).ts", yes: ["src/a+b(x).ts"], no: ["src/abx.ts"] },
    ];
    for (const { entry, yes, no } of cases) {
      const config = normalizeProjectConfig(rawConfig(field, [entry]), "/repo");
      /** @param {string} file */
      const matches = (file) =>
        field === "check_selection[0].paths"
          ? selectChecks(config, [file]).includes("ok")
          : field === "tests.paths"
            ? isTestPath(config, file)
            : canRunTestPath(config, file);
      for (const file of yes) assert.equal(matches(file), true, `${entry}: ${file}`);
      for (const file of no) assert.equal(matches(file), false, `${entry}: ${file}`);
    }
  });

  test(`${field} rejects unsupported patterns on config load and names the entry`, () => {
    for (const entry of [
      "src/**/x.ts",
      "src/*/x.ts",
      "src*/",
      "src/x?.ts",
      "src/x[.ts",
      "src/x].ts",
      "src/x{.ts",
      "src/x}.ts",
      "**.ts",
      "src*/x.ts",
    ]) {
      const raw = rawConfig(field, [entry]);
      assert.throws(
        () => loadProjectConfig("/repo", { readFile: () => JSON.stringify(raw) }),
        (error) => {
          assert.equal(error.errorClass, "config");
          assert.ok(error.message.includes(field), error.message);
          assert.ok(error.message.includes(JSON.stringify(entry)), error.message);
          return true;
        },
      );
    }
  });

  test(`apocha validate rejects unsupported ${field} patterns from the base config`, () => {
    for (const entry of ["src/**/x.ts", "src/*/x.ts", "src*/", "src/x?.ts"]) {
      const repo = makeRepo({ config: rawConfig(field, [entry]) });
      const manifest = path.join(repo.root, "task.json");
      writeFileSync(manifest, JSON.stringify(valueTask({ checks: ["ok"] })));
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../bin/apocha.mjs", import.meta.url)), "validate", manifest],
        { cwd: repo.root, encoding: "utf8" },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes(field), result.stderr);
      assert.ok(result.stderr.includes(entry), result.stderr);
    }
  });
}
