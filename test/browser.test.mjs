// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDefinitionDigest, runCheck } from "../src/checks/runner.mjs";
import { normalizeProjectConfig } from "../src/config/project.mjs";
import { bwrapArgs, detectBackend, seatbeltProfile } from "../src/sandbox/index.mjs";
import { makeRepo, testCandidate } from "./helpers.mjs";

test("browser normalization, validation and definition digest are explicit", () => {
  const config = normalizeProjectConfig(
    {
      version: 1,
      checks: {
        absent: { run: ["node"] },
        off: { run: ["node"], browser: false },
        on: { run: ["node"], browser: true },
      },
    },
    "/",
  );
  assert.equal(config.checks.absent.browser, false);
  assert.equal(config.checks.off.browser, false);
  assert.equal(config.checks.on.browser, true);
  assert.equal(config.checks.on.loopback, false);
  assert.equal(config.checks.on.network, false);
  assert.equal(checkDefinitionDigest(config.checks.absent), checkDefinitionDigest(config.checks.off));
  assert.notEqual(checkDefinitionDigest(config.checks.off), checkDefinitionDigest(config.checks.on));
  assert.throws(() =>
    normalizeProjectConfig(
      {
        version: 1,
        checks: { bad: { run: ["node"], browser: "true" } },
      },
      "/",
    ),
  );
});

test("browser adds exactly two Chromium Mach rules on Seatbelt only", () => {
  const policy = { writable: [], denyRead: [], network: false, cwd: "/" };
  const base = seatbeltProfile(policy);
  assert.equal(seatbeltProfile({ ...policy, browser: false }), base);
  assert.doesNotMatch(base, /org\.chromium\./);
  const lines = seatbeltProfile({ ...policy, browser: true }).split("\n");
  const added = lines.filter((line) => !base.split("\n").includes(line));
  assert.deepEqual(
    added.filter((line) => !line.startsWith(";")),
    [
      '(allow mach-register (global-name-prefix "org.chromium."))',
      '(allow mach-lookup (global-name-prefix "org.chromium."))',
    ],
  );
  assert.equal(added.filter((line) => line.startsWith(";")).length, 1);
  assert.equal(lines.filter((line) => line.includes("org.chromium.")).length, 2);
  assert.equal(lines.filter((line) => !added.includes(line)).join("\n"), base);
  assert.equal(
    seatbeltProfile({ ...policy, network: true, browser: true }),
    seatbeltProfile({ ...policy, network: true }),
  );
  assert.deepEqual(bwrapArgs({ ...policy, browser: true }, ["node"], []), bwrapArgs(policy, ["node"], []));
});

test("Seatbelt browser check loads a local page in Playwright Chromium", {
  skip: detectBackend() === "seatbelt" ? false : "Seatbelt backend unavailable",
  timeout: 60000,
}, async (t) => {
  const require = createRequire(import.meta.url);
  let modulePath;
  for (const name of ["playwright", "playwright-core"]) {
    try {
      modulePath = require.resolve(name);
      break;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (!modulePath) {
    t.skip("Playwright is not installed");
    return;
  }
  const { chromium } = require(modulePath);
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) {
    t.skip("Playwright Chromium is not installed");
    return;
  }
  const script = `import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(${JSON.stringify(modulePath)});
const server = http.createServer((request, response) => response.end("<title>sandbox browser</title>"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: ${JSON.stringify(executablePath)} });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  assert.equal(await page.title(), "sandbox browser");
  console.log("LOCAL PAGE LOADED");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}`;
  const repo = makeRepo({ files: { "browser.mjs": script } });
  const candidate = testCandidate(repo.root, "main");
  try {
    const config = normalizeProjectConfig(
      {
        version: 1,
        checks: {
          browser: {
            run: [process.execPath, "browser.mjs"],
            browser: true,
            loopback: true,
            timeout_ms: 45000,
            env: {
              PLAYWRIGHT_BROWSERS_PATH:
                process.env.PLAYWRIGHT_BROWSERS_PATH ??
                path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
            },
          },
        },
        sandbox: { mode: "required" },
      },
      repo.root,
    );
    const result = await runCheck({ check: config.checks.browser, candidate, config, backend: "seatbelt" });
    assert.equal(result.status, "pass", result.error ?? result.stderr);
    assert.equal(result.sandbox, "seatbelt");
    assert.match(result.stdout, /LOCAL PAGE LOADED/);
  } finally {
    candidate.cleanup();
    repo.cleanup();
  }
});
