// @ts-check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeProjectConfig, PROJECT_CONFIG_FILE } from "../config/project.mjs";
import { HarnessError } from "../util/errors.mjs";

/**
 * Write a starter panagent.config.json. Detects an npm package (scripts become
 * checks) or a Python project (pytest). Never overwrites without --force.
 *
 * @param {string} root
 * @param {{ force?: boolean }} [options]
 */
export function initProject(root, options = {}) {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  if (existsSync(file) && !options.force)
    throw new HarnessError(
      "config",
      "exists",
      `${PROJECT_CONFIG_FILE} already exists (use --force to replace it)`,
    );
  /** @type {Record<string, any>} */
  const checks = {};
  const pkgFile = path.join(root, "package.json");
  if (existsSync(pkgFile)) {
    const scripts = JSON.parse(readFileSync(pkgFile, "utf8")).scripts ?? {};
    const dependencies = existsSync(path.join(root, "package-lock.json")) ? "npm" : "none";
    for (const name of ["lint", "typecheck", "test", "build"]) {
      if (scripts[name])
        checks[name] = {
          run: ["npm", name === "test" ? "test" : "run", ...(name === "test" ? [] : [name])],
          cwd: ".",
          timeout_ms: 300000,
          dependencies,
        };
    }
  }
  if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "setup.py"))) {
    checks.pytest = {
      run: ["{source}/.venv/bin/python", "-m", "pytest", "-q"],
      cwd: ".",
      timeout_ms: 600000,
      dependencies: "none",
    };
  }
  if (!Object.keys(checks).length)
    checks.example = { description: "Replace with a real check", run: ["node", "--version"], cwd: "." };
  const config = {
    version: 1,
    checks,
    default_checks: Object.keys(checks),
    paths: { protected: [".github/"], governance: ["AGENTS.md"], forbidden: [] },
    sandbox: { mode: "auto", network: "deny" },
  };
  normalizeProjectConfig(config, root);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return `wrote ${PROJECT_CONFIG_FILE} with checks: ${Object.keys(checks).join(", ")}
next:
  1. review the checks and paths (docs/configuration.md)
  2. choose runtimes in .panagent/runtimes.json or ~/.config/panagent/runtimes.json
  3. panagent doctor`;
}
