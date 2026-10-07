// @ts-check
import { loadSchema } from "../util/schema.mjs";

/**
 * Tool names, descriptions, and input schemas, shared by every runtime
 * binding (MCP server, Pi extension, fake adapter). Descriptions are written
 * for the model: what the tool does, its limits, and how to recover.
 */

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const pathList = { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } };

/** @type {Record<string, { description: string, inputSchema: Record<string, any>, roles: ("implementer" | "reviewer")[] }>} */
const TOOLS = {
  read_files: {
    description:
      "Read up to 20 text files (each up to 200 KB). Paths are repository-relative. Use read_file_range for larger files. Deleted files report deleted_in_candidate.",
    inputSchema: object({ paths: pathList }),
    roles: ["implementer", "reviewer"],
  },
  read_file_range: {
    description: "Read inclusive 1-based lines start_line..end_line of one text file (files up to 2 MB).",
    inputSchema: object({
      path: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    }),
    roles: ["implementer", "reviewer"],
  },
  read_base_file: {
    description:
      "Read a file as it was at the base commit, before any change in this task. Reports exists_at_base: false for new files.",
    inputSchema: object({ path: { type: "string" } }),
    roles: ["implementer", "reviewer"],
  },
  stat_paths: {
    description:
      "Check up to 20 paths for existence, type (file or directory), size, and whether a file is binary. Returns no content.",
    inputSchema: object({ paths: pathList }),
    roles: ["implementer", "reviewer"],
  },
  search_code: {
    description:
      "Find lines containing a literal string. Searches readable paths by default, or the given paths. Returns at most 100 matches.",
    inputSchema: object({ query: { type: "string" }, paths: pathList }, ["query"]),
    roles: ["implementer", "reviewer"],
  },
  apply_patch: {
    description:
      'Edit files inside allowed_paths. Each edit replaces exactly one occurrence of old_text with new_text in path. old_text must match the file exactly once, including whitespace, and line breaks must be real newlines. Use old_text "" to create a new file, or { path, delete: true } to delete one. Edits apply in order, so several edits to the same file are fine.',
    inputSchema: object({
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: object(
          {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
            delete: { type: "boolean" },
          },
          ["path"],
        ),
      },
    }),
    roles: ["implementer"],
  },
  run_check: {
    description:
      "Run one of the task's named checks (tests, typecheck, lint, ...) on your current changes and get its output, failure lines first. Limited calls per attempt. Use it to verify before submitting.",
    inputSchema: object({ check_id: { type: "string" } }),
    roles: ["implementer"],
  },
};

/**
 * Tool definitions for a role, including `submit_result` with the role's output schema.
 * @param {"implementer" | "reviewer"} role
 * @returns {{ name: string, description: string, inputSchema: Record<string, any> }[]}
 */
export function toolDefinitions(role) {
  const list = Object.entries(TOOLS)
    .filter(([, tool]) => tool.roles.includes(role))
    .map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema }));
  const {
    $schema: _s,
    title: _t,
    ...outputSchema
  } = loadSchema(role === "implementer" ? "implementer-output.schema.json" : "reviewer-output.schema.json");
  for (const keyword of ["if", "then", "else", "not", "allOf", "anyOf", "oneOf"])
    delete outputSchema[keyword];
  if (role === "implementer") {
    outputSchema.properties.status.description =
      'Use "blocked" when the task cannot be completed; status "blocked" requires blocked_reason. Otherwise use "done" (the default) and omit blocked_reason.';
    outputSchema.properties.blocked_reason.description =
      'Required only when status is "blocked"; explain the blocking tests, checks, or paths and why. Must be omitted otherwise.';
  }
  list.push({
    name: "submit_result",
    description:
      "Submit your final structured result. Call it exactly once, as your last action. The run ends when you call it.",
    inputSchema: outputSchema,
  });
  return list;
}
