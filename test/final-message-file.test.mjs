// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

for (const writeFails of [false, true]) {
  test(
    writeFails
      ? "a final-message diagnostic write failure does not fail the run"
      : "an existing final-message file is replaced with bounded text",
    async () => {
      const repo = makeRepo();
      const store = new RunStore(repo.root);
      const finalMessage = "new final message ".repeat(200);
      const fake = createFakeAdapter({
        handlers: {
          implementer: async (context) => {
            await writeValue(2)(context);
            const runs = store.list();
            assert.equal(runs.length, 1);
            const file = path.join(store.sessionDir(runs[0].run_id, 1), "final-message.txt");
            if (writeFails) mkdirSync(file);
            else writeFileSync(file, "previous diagnostic", { mode: 0o600 });
            return { final_message: finalMessage };
          },
          reviewer: passReviewer,
        },
      });
      const summary = await startRun({
        cwd: repo.root,
        base: "main",
        batch: "final-message-file",
        message: "Set value",
        task: valueTask({ max_repair_attempts: 0 }),
        runtimes: fakeRuntimes(),
        adapters: { implementer: fake, reviewer: fake },
      });
      assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
      const file = path.join(store.sessionDir(summary.run_id, 1), "final-message.txt");
      if (writeFails) {
        assert.ok(statSync(file).isDirectory());
      } else {
        assert.equal(readFileSync(file, "utf8"), finalMessage.slice(0, 2000));
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
      const finished = store.events(summary.run_id).filter((event) => event.type === "agent.finished");
      assert.equal(finished.length, 2);
      assert.equal(finished[0].role, "implementer");
      assert.equal(finished[0].final_message_chars, 2000);
      if (writeFails) assert.equal(finished[0].final_message_saved, false);
      else assert.ok(!Object.hasOwn(finished[0], "final_message_saved"));
      assert.ok(!Object.hasOwn(finished[1], "final_message_chars"));
      assert.ok(!Object.hasOwn(finished[1], "final_message_saved"));
    },
  );
}
