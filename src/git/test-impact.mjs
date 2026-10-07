// @ts-check
import path from "node:path";
import { isTestPath } from "../config/project.mjs";
import { git } from "../util/git.mjs";
import { inAnyScope } from "../util/paths.mjs";
import { sourceTokens } from "./test-source.mjs";

/** @param {string} source */
function specifiers(source) {
  const tokens = sourceTokens(source);
  const found = [];
  const literal = (token) => (token && /^["']/.test(token) ? token.slice(1, -1) : null);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "import" || token === "require") {
      const value = literal(tokens[i + 1] === "(" ? tokens[i + 2] : tokens[i + 1]);
      if (value && (tokens[i + 1] !== "(" || tokens[i + 3] === ")" || tokens[i + 3] === ","))
        found.push(value);
    }
    if (token === "from" && literal(tokens[i + 1])) found.push(literal(tokens[i + 1]));
  }
  return found.filter((value) => value?.startsWith("./") || value?.startsWith("../"));
}

/** Existing tests whose base-tree imports reach editable non-test code.
 * @param {string} root @param {string} baseCommit
 * @param {import("../config/project.mjs").ProjectConfig} config
 * @param {import("../config/task.mjs").Task} task
 */
export function testImpact(root, baseCommit, config, task) {
  const files = new Set(
    String(git(root, ["ls-tree", "-r", "--name-only", "-z", baseCommit]).stdout)
      .split("\0")
      .filter(Boolean),
  );
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  const imports = (file) => {
    if (graph.has(file)) return graph.get(file) ?? [];
    const source = String(git(root, ["show", `${baseCommit}:${file}`]).stdout);
    const resolved = specifiers(source).flatMap((specifier) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const match = [
        target,
        ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", "/index.mjs", "/index.js", "/index.ts"].map(
          (suffix) => target + suffix,
        ),
      ].find((name) => files.has(name));
      return match ? [match] : [];
    });
    graph.set(file, resolved);
    return resolved;
  };
  const declared = new Set((task.test_changes ?? []).map((entry) => entry.path));
  const impact = [];
  for (const file of [...files].filter((name) => isTestPath(config, name)).sort()) {
    const queue = [[file]];
    const seen = new Set([file]);
    for (let index = 0; index < queue.length; index++) {
      const chain = queue[index];
      const current = chain[chain.length - 1];
      if (!isTestPath(config, current) && inAnyScope(current, task.allowed_paths)) {
        impact.push({ path: file, chain, declared: declared.has(file) });
        break;
      }
      for (const target of imports(current)) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push([...chain, target]);
        }
      }
    }
  }
  return impact;
}
