// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectCodexEvent } from "../src/adapters/codex/index.mjs";
import { runJsonlProcess } from "../src/adapters/process.mjs";
import { startRun } from "../src/core/run.mjs";
import { RunStore } from "../src/core/runs.mjs";
import { renderBundle } from "../src/stages/invoke.mjs";
import {
  createFakeAdapter,
  fakeRuntimes,
  makeRepo,
  passReviewer,
  valueTask,
  writeValue,
} from "./helpers.mjs";

const paragraph =
  "Your previous session in this attempt ended without calling submit_result. The candidate keeps every change you made. Continue from the current state: finish the task, run the checks you need, and call submit_result (status done with criteria_evidence, or blocked with a blocked_reason).";

/** @param {import("../src/adapters/fake/index.mjs").FakeHandler} implementer
 * @param {import("../src/adapters/fake/index.mjs").FakeHandler} [reviewer]
 * @param {number} [budget]
 */
async function run(implementer, reviewer = passReviewer, budget = 50) {
  const repo = makeRepo();
  const fake = createFakeAdapter({ handlers: { implementer, reviewer } });
  const summary = await startRun({
    cwd: repo.root,
    base: "main",
    batch: "continuation",
    message: "Set value",
    task: valueTask({ max_repair_attempts: 0 }),
    runtimes: fakeRuntimes({ budgets: { timeout_ms: 60000, max_tool_calls: budget } }),
    adapters: { implementer: fake, reviewer: fake },
  });
  const store = new RunStore(repo.root);
  return { summary, store, state: store.read(summary.run_id).state, events: store.events(summary.run_id) };
}

test("continuation keeps the candidate, attempt and normal prompt with separate tool budgets", async () => {
  let invocations = 0;
  const prompts = [];
  const { summary, store, state, events } = await run(async ({ call, bundle, taskPrompt, root }) => {
    invocations += 1;
    prompts.push({ taskPrompt, bundle, root });
    assert.equal(bundle.attempt, 0);
    const read = await call("read_files", { paths: ["src/value.txt"] });
    for (let i = 0; i < 48; i += 1) await call("read_files", { paths: ["src/value.txt"] });
    if (invocations === 1) {
      assert.equal(read.files[0].content, "1\n");
      await call("apply_patch", { edits: [{ path: "src/value.txt", old_text: "1\n", new_text: "2\n" }] });
      return { final_message: "Continuing soon" };
    }
    assert.equal(read.files[0].content, "2\n");
    await call("submit_result", { summary: "Finished retained change" });
    return { final_message: "x".repeat(2100) };
  });
  assert.equal(summary.outcome, "PASSED", summary.reason ?? "");
  assert.equal(invocations, 2);
  assert.equal(summary.repairs, 0);
  assert.equal(summary.retries, 0);
  assert.equal(state.attempt, 1);
  assert.equal(state.invocations, 3); // Includes the reviewer.
  assert.equal(prompts[0].root, prompts[1].root);
  assert.deepEqual(prompts[0].bundle, prompts[1].bundle);
  assert.equal(prompts[0].taskPrompt, renderBundle("implementer", prompts[0].bundle));
  assert.equal(prompts[1].taskPrompt, prompts[0].taskPrompt + "\n" + paragraph + "\n");
  const continued = events.filter((event) => event.type === "implementer.continued");
  assert.equal(continued.length, 1);
  assert.equal(continued[0].invocation, 2);
  assert.equal(continued[0].previous_tool_calls, 50);
  assert.equal(events.filter((event) => event.type === "agent.retry").length, 0);
  const finished = events.filter((event) => event.type === "agent.finished");
  assert.equal(finished.length, 3);
  for (const event of finished) assert.ok(!("final_message" in event));
  assert.equal(finished[0].final_message_chars, 15);
  assert.equal(finished[1].final_message_chars, 2000);
  assert.ok(!("final_message_chars" in finished[2]));
  for (const [index, text] of ["Continuing soon", "x".repeat(2000)].entries()) {
    const file = path.join(store.sessionDir(summary.run_id, index + 1), "final-message.txt");
    assert.equal(readFileSync(file, "utf8"), text);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.ok(!existsSync(path.join(store.sessionDir(summary.run_id, 3), "final-message.txt")));
});

for (const secondCalls of [true, false]) {
  test(`second missing result escalates after two invocations (second tool calls: ${secondCalls})`, async () => {
    let invocations = 0;
    const { summary, events } = await run(async ({ call }) => {
      invocations += 1;
      if (invocations === 1 || secondCalls) await call("read_files", { paths: ["src/value.txt"] });
    });
    assert.equal(summary.outcome, "ESCALATED");
    assert.match(summary.reason ?? "", /agent\/no_result/);
    assert.equal(invocations, 2);
    assert.equal(summary.retries, 0);
    assert.equal(summary.repairs, 0);
    assert.equal(events.filter((event) => event.type === "implementer.continued").length, 1);
  });
}

test("no-tool invocations retry without continuation and record available final text", async () => {
  let invocations = 0;
  const { summary, events } = await run(async ({ taskPrompt }) => {
    invocations += 1;
    assert.ok(!taskPrompt.includes(paragraph));
    return { final_message: "No tools used" };
  });
  assert.equal(summary.outcome, "ESCALATED");
  assert.equal(invocations, 2);
  assert.equal(summary.retries, 1);
  assert.equal(events.filter((event) => event.type === "implementer.continued").length, 0);
  const retries = events.filter((event) => event.type === "agent.retry");
  assert.equal(retries[0].reason.code, "no_result_no_tools");
  for (const event of events.filter((entry) => entry.type === "agent.finished")) {
    assert.ok(!("final_message" in event));
    assert.equal(event.final_message_chars, 13);
  }
});

test("a reviewer with tool calls and no result never continues", async () => {
  let reviews = 0;
  const { summary, events } = await run(writeValue(2), async ({ call, taskPrompt }) => {
    reviews += 1;
    assert.ok(!taskPrompt.includes(paragraph));
    await call("read_files", { paths: ["src/value.txt"] });
  });
  assert.equal(summary.outcome, "ESCALATED");
  assert.match(summary.reason ?? "", /agent\/no_result/);
  assert.equal(reviews, 1);
  assert.equal(summary.retries, 0);
  assert.equal(events.filter((event) => event.type === "implementer.continued").length, 0);
});

test("Codex JSON stream takes the last completed agent message and truncates it", async () => {
  /** @type {{ usage: any, errors: string[], final_message?: string }} */
  const state = { usage: null, errors: [] };
  const stream = [
    { type: "item.completed", item: { type: "agent_message", text: "First" } },
    { type: "item.completed", item: { type: "agent_message", text: "Last " + "x".repeat(2100) } },
    { type: "item.started", item: { type: "agent_message", text: "Incomplete" } },
    { type: "turn.completed", usage: { input_tokens: 1 } },
  ];
  const exit = await runJsonlProcess({
    command: process.execPath,
    args: ["-e", `for (const event of ${JSON.stringify(stream)}) console.log(JSON.stringify(event));`],
    cwd: os.tmpdir(),
    env: {},
    input: "",
    timeoutMs: 10000,
    onEvent: (event) => inspectCodexEvent(event, state),
  });
  assert.equal(exit.code, 0);
  assert.equal(state.final_message, "Last " + "x".repeat(1995));
});
