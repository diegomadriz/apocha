// @ts-check
import { readFileSync } from "node:fs";
import { toolDefinitions } from "../../tools/definitions.mjs";
import { createProjectTools } from "../../tools/project-tools.mjs";

/**
 * Pi extension that registers the harness tools in-process. Loaded with
 * `--extension` while every built-in tool, extension, skill, and context file
 * is disabled. Environment: APOCHA_SESSION = session config path.
 *
 * @param {any} pi Pi's ExtensionAPI
 */
export default function registerApochaTools(pi) {
  const sessionFile = process.env.APOCHA_SESSION;
  if (!sessionFile) throw new Error("APOCHA_SESSION is required");
  const session = JSON.parse(readFileSync(sessionFile, "utf8"));
  const tools = createProjectTools(session);
  for (const definition of toolDefinitions(session.role)) {
    pi.registerTool({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      promptSnippet: definition.description,
      parameters: definition.inputSchema,
      async execute(_toolCallId, params) {
        const outcome = await tools.call(definition.name, params);
        if (!outcome.ok) throw new Error(outcome.error);
        const text = JSON.stringify(outcome.value);
        return {
          content: [{ type: "text", text }],
          details: {},
          ...(definition.name === "submit_result" ? { terminate: true } : {}),
        };
      },
    });
  }
}
