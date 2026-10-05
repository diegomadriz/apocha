#!/usr/bin/env node
// @ts-check
// Entry point the Codex and Claude Code adapters launch as the harness MCP server.
import { startMcpToolServer } from "./mcp-server.mjs";

startMcpToolServer();
