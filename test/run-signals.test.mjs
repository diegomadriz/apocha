// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { main } from "../src/cli/main.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git } from "../src/util/git.mjs";
import { createFakeAdapter, fakeRuntimes, makeRepo, valueTask } from "./helpers.mjs";

for (const command of ["run", "integrate", "resume"]) {
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    test(`${command} handles ${signal} and removes its handlers`, async (t) => {
      const repo = makeRepo();
      const cwd = process.cwd();
      const listeners = {
        SIGINT: process.listeners("SIGINT"),
        SIGTERM: process.listeners("SIGTERM"),
      };
      try {
        const runtimePath = `${repo.root}/runtimes.json`;
        writeFileSync(
          runtimePath,
          JSON.stringify({
            version: 1,
            roles: { implementer: { adapter: "fake" }, reviewer: { adapter: "fake" } },
          }),
        );
        let args;
        if (command === "resume") {
          const fake = createFakeAdapter({
            handlers: {
              implementer: async () => {
                throw new HarnessError("usage_limited", "limit", "usage limit");
              },
            },
          });
          const paused = await startRun({
            cwd: repo.root,
            base: "main",
            batch: "signal-test",
            message: "Signal test",
            task: valueTask(),
            runtimes: fakeRuntimes(),
            adapters: { implementer: fake, reviewer: fake },
          });
          assert.equal(paused.outcome, "PAUSED");
          args = ["resume", paused.run_id];
        } else if (command === "integrate") {
          git(repo.root, ["checkout", "-qb", "topic"]);
          writeFileSync(`${repo.root}/src/value.txt`, "2\n");
          git(repo.root, ["commit", "-qam", "topic change"]);
          git(repo.root, ["checkout", "-q", "main"]);
          args = ["integrate", "topic", "--onto", "main", "--batch", "signal-test"];
        } else {
          const taskPath = `${repo.root}/task.json`;
          writeFileSync(taskPath, JSON.stringify(valueTask()));
          args = ["run", taskPath, "--base", "main", "--batch", "signal-test", "--message", "test"];
        }
        const event = RunStore.prototype.event;
        t.mock.method(RunStore.prototype, "event", function (id, type, data) {
          event.call(this, id, type, data);
          if (type === "run.started" || type === "run.resumed") process.emit(signal);
        });
        process.chdir(repo.root);
        const exit = await main([...args, "--runtimes", runtimePath, "--quiet", "--json"]);
        assert.equal(exit, signal === "SIGINT" ? 130 : 143);
        const [record] = new RunStore(repo.root).list();
        assert.equal(record.outcome, "ERROR");
        assert.equal(record.error_class, "infra");
        assert.equal(record.code, "aborted");
        assert.ok(record.finished_at);
        assert.deepEqual(process.listeners("SIGINT"), listeners.SIGINT);
        assert.deepEqual(process.listeners("SIGTERM"), listeners.SIGTERM);
      } finally {
        process.chdir(cwd);
        t.mock.restoreAll();
        repo.cleanup();
      }
    });
  }
}
