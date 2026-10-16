// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

test("events contain no model final-message text from either role", async () => {
  const marker = "MODEL_FINAL_MESSAGE_PRIVATE_MARKER";
  const repo = makeRepo();
  const roles = [];
  const fake = createFakeAdapter({
    handlers: {
      implementer: async (context) => {
        roles.push(context.role);
        await writeValue(2)(context);
        return { final_message: `${marker} implementer` };
      },
      reviewer: async (context) => {
        roles.push(context.role);
        await passReviewer(context);
        return { final_message: `${marker} reviewer` };
      },
    },
  });
  const summary = await startRun({
    cwd: repo.root,
    base: "main",
    batch: "events-metadata",
    message: "Set value",
    task: valueTask({ max_repair_attempts: 0 }),
    runtimes: fakeRuntimes(),
    adapters: { implementer: fake, reviewer: fake },
  });
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.deepEqual(roles, ["implementer", "reviewer"]);
  const store = new RunStore(repo.root);
  const lines = readFileSync(path.join(store.dir(summary.run_id), "events.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(!line.includes(marker));
});
