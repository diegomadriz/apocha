// @ts-check
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProjectTools } from "../../tools/project-tools.mjs";

/**
 * A scripted adapter for tests and demos. The handler receives the role, the
 * bundle, and a `call(tool, args)` function bound to the real harness tools,
 * so a fake run exercises the same scopes, traces, and result validation as a
 * live one.
 *
 * @typedef {(context: { role: string, taskPrompt: string, bundle: Record<string, any>, attempt: number, root: string, call: (name: string, args: unknown) => Promise<any> }) => unknown | Promise<unknown>} FakeHandler
 */

/**
 * @param {{ handlers?: Partial<Record<"implementer" | "reviewer", FakeHandler>>, script?: string }} [options]
 */
export function createFakeAdapter(options = {}) {
  /** @type {Partial<Record<string, FakeHandler>> | null} */
  let loaded = options.handlers ?? null;
  return {
    name: "fake",
    probe() {
      return { adapter: "fake", version: "0", ok: true, problems: [] };
    },
    /** @param {import("../contract.mjs").Invocation} invocation */
    async run(invocation) {
      if (!loaded) {
        if (!options.script) throw new Error("fake adapter needs handlers or a script");
        const module = await import(pathToFileURL(path.resolve(options.script)).href);
        loaded = module.default ?? module;
      }
      const handler = loaded?.[invocation.role];
      if (!handler) throw new Error(`fake adapter has no handler for ${invocation.role}`);
      const session = JSON.parse(readFileSync(invocation.sessionFile, "utf8"));
      const tools = createProjectTools(session);
      const call = async (name, args) => {
        const outcome = await tools.call(name, args);
        if (!outcome.ok) throw new Error(outcome.error);
        return outcome.value;
      };
      const output = await handler({
        role: invocation.role,
        taskPrompt: invocation.taskPrompt,
        bundle: invocation.bundle,
        attempt: Number(invocation.bundle.attempt ?? 0),
        root: session.root,
        call,
      });
      return {
        runtime: {
          adapter: "fake",
          adapter_version: "0",
          provider: "fake",
          model: invocation.model ?? "scripted",
        },
        usage: null,
        ...(output &&
        typeof output === "object" &&
        "final_message" in output &&
        typeof output.final_message === "string"
          ? { final_message: output.final_message }
          : {}),
      };
    },
  };
}
