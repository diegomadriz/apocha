// @ts-check
import { readFileSync } from "node:fs";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toolDefinitions } from "../tools/definitions.mjs";
import { createProjectTools } from "../tools/project-tools.mjs";
import { GENERATOR } from "../version.mjs";
import { MCP_SERVER_NAME } from "./mcp-names.mjs";

/**
 * The harness tool server over MCP stdio, launched by the Codex and Claude Code
 * adapters. It serves both protocol eras (2025 handshake and the 2026-07-28
 * stateless protocol) through the official SDK's `serveStdio`.
 *
 * This is the only module that imports the MCP SDK.
 *
 * Environment: APOCHA_SESSION = path to the session config JSON written by the controller.
 */

export function startMcpToolServer() {
  const sessionFile = process.env.APOCHA_SESSION;
  if (!sessionFile) {
    process.stderr.write("APOCHA_SESSION is required\n");
    process.exit(2);
  }
  const session = JSON.parse(readFileSync(sessionFile, "utf8"));
  const tools = createProjectTools(session);
  const definitions = toolDefinitions(session.role);
  return serveStdio(
    () => {
      const server = new McpServer(
        { name: MCP_SERVER_NAME, version: GENERATOR.version },
        { capabilities: { tools: {} } },
      );
      for (const definition of definitions) {
        server.registerTool(
          definition.name,
          { description: definition.description, inputSchema: fromJsonSchema(definition.inputSchema) },
          async (args) => {
            const outcome = await tools.call(definition.name, args);
            if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.value) }] };
            return { content: [{ type: "text", text: outcome.error }], isError: true };
          },
        );
      }
      return server;
    },
    { onerror: (error) => process.stderr.write(`apocha mcp: ${error.message}\n`) },
  );
}
