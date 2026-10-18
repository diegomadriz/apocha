// @ts-check

/** Tokenize static JavaScript syntax, keeping strings and excluding comments. @param {string} source */
export function sourceTokens(source) {
  return [
    ...source.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
}

/** Conservative recognition of runnable test registrations and assertions. @param {string} source */
export function hasRunnableTests(source) {
  const tokens = sourceTokens(source);
  return tokens.some(
    (token, index) =>
      /^(test|it|describe|suite|assert|expect)$/.test(token) &&
      (tokens[index + 1] === "(" || tokens[index + 1] === "."),
  );
}

/** Advisory token heuristic for assertion preservation and potential test bypasses.
 * Renamed locals or extracted helpers may fail this heuristic without changing outcomes.
 * @param {string} base @param {string} next
 */
export function preservesAssertions(base, next) {
  const assertions = (source) => {
    const tokens = sourceTokens(source);
    const calls = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!/^(assert|expect)$/.test(tokens[i])) continue;
      let end = i;
      while (end < tokens.length && tokens[end] !== ";") end++;
      calls.push(tokens.slice(i, end).join(" "));
    }
    return calls;
  };
  const remaining = assertions(next);

  return (
    assertions(base).every((call) => {
      const index = remaining.indexOf(call);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    }) && classifyTestBypasses(base, next).length === 0
  );
}

/** Tokens with candidate offsets; comments and quoted fixtures are never executable.
 * This is lexical recognition, not a parser or proof of execution.
 * @param {string} source
 */
function bypassTokens(source) {
  return [
    ...source.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|=>|[\w$]+|[^\s]/g,
    ),
  ]
    .filter((m) => !/^(\/\/|\/\*|#)/.test(m[0]))
    .map((m) => ({ value: m[0], offset: m.index }));
}

/** Find newly introduced lexical bypass constructs in preexisting registrations.
 * New registrations, comments, string fixtures, and helper returns are excluded.
 * Conditional runtime skips, aliases, computed properties and dynamic code require review.
 * @param {string} baseText @param {string} newText
 * @returns {{line: number, reason: string}[]}
 */
export function classifyTestBypasses(baseText, newText) {
  /** @param {string} source */
  const inspect = (source) => {
    const tokens = bypassTokens(source);
    const t = tokens.map((token) => token.value);
    /** @type {Map<number, number>} */
    const closing = new Map();
    /** @type {number[]} */
    const stack = [];
    for (let i = 0; i < t.length; i++) {
      if (["(", "{", "["].includes(t[i])) stack.push(i);
      else if ([")", "}", "]"].includes(t[i])) {
        const open = stack.pop();
        if (open !== undefined) closing.set(open, i);
      }
    }
    /** @type {{key: string, start: number, end: number, body: number, flags: {index: number, reason: string}[]}[]} */
    const registrations = [];
    // Python test functions provide identity for new-registration exclusion too.
    for (const match of source.matchAll(/^( *)(?:async\s+)?def\s+(test_\w+)\s*\(/gm)) {
      const offset = match.index;
      const tail = source.slice(offset + match[0].length);
      const boundary = /\n([^\S\n]*)(?=\S)/g;
      let endOffset = source.length;
      for (const line of tail.matchAll(boundary)) {
        if (line[1].length <= match[1].length) {
          endOffset = offset + match[0].length + line.index;
          break;
        }
      }
      let startOffset = offset;
      const preceding = source.slice(0, offset).split("\n");
      // Include consecutive single-line decorators in their function identity.
      for (let line = preceding.length - 2; line >= 0 && preceding[line].trim().startsWith("@"); line--)
        startOffset -= preceding[line].length + 1;
      const start = tokens.findIndex((token) => token.offset >= startOffset);
      const end = tokens.findIndex((token) => token.offset >= endOffset);
      registrations.push({
        key: "python:" + match[2],
        start,
        end: end < 0 ? t.length : end,
        body: -1,
        flags: [],
      });
    }
    for (let i = 0; i < t.length; i++) {
      if (!/^(test|it|describe|suite)$/.test(t[i]) || t[i - 1] === ".") continue;
      let call = i + 1;
      const flags = [];
      while (t[call] === "." && /^[\w$]+$/.test(t[call + 1] ?? "")) {
        if (/^(skip|only)$/.test(t[call + 1]))
          flags.push({ index: call + 1, reason: "registration ." + t[call + 1] });
        call += 2;
      }
      if (t[call] !== "(" || !/^["'`]/.test(t[call + 1] ?? "")) continue;
      const end = closing.get(call);
      if (end === undefined) continue;
      let body = -1;
      for (let j = call + 2; j < end; j++) {
        if (t[j] === "{") {
          const stop = closing.get(j) ?? j;
          for (let k = j + 1; k < stop; k++) {
            if (/^(skip|todo|only)$/.test(t[k]) && t[k + 1] === ":" && t[k + 2] !== "false")
              flags.push({ index: k, reason: "registration option " + t[k] });
          }
          j = stop;
        } else if (t[j] === "=>" || t[j] === "function") {
          body = j + 1;
          if (t[j] === "function") {
            while (body < end && t[body] !== "{") body++;
          }
          break;
        } else if (t[j] === "(" || t[j] === "[") j = closing.get(j) ?? j;
      }
      registrations.push({
        key: t[i] + ":" + t[call + 1].slice(1, -1),
        start: i,
        end,
        body,
        flags,
      });
    }
    /** @type {{key: string, index: number, reason: string}[]} */
    const findings = [];
    /** @param {string} key @param {number} index @param {string} reason */
    const add = (key, index, reason) => findings.push({ key: key + ":" + reason, index, reason });
    for (const registration of registrations) {
      for (const flag of registration.flags) add(registration.key, flag.index, flag.reason);
      const first = registration.body + (t[registration.body] === "{" ? 1 : 0);
      if (registration.body >= 0 && t[first] === "return")
        add(registration.key, first, "first-statement return");
      if (
        registration.body >= 0 &&
        /^[\w$]+$/.test(t[first] ?? "") &&
        t[first + 1] === "." &&
        t[first + 2] === "skip" &&
        t[first + 3] === "("
      )
        add(registration.key, first, "first-statement runtime skip");
    }
    for (let i = 0; i < t.length; i++) {
      const registration = [...registrations].reverse().find((r) => r.start <= i && i <= r.end);
      const key = registration?.key ?? "module";
      if (t[i] === "process" && t[i + 1] === "." && t[i + 2] === "exit" && t[i + 3] === "(") {
        const start = registration ? registration.body : 0;
        // Only a direct callback/module statement before assertions; helper bodies are excluded.
        let depth = 0;
        for (let j = Math.max(0, start); j < i; j++) {
          if (t[j] === "{") depth++;
          if (t[j] === "}") depth--;
        }
        if (
          depth === (registration && t[start] === "{" ? 1 : 0) &&
          !t
            .slice(Math.max(0, start), i)
            .some(
              (v, index, slice) =>
                /^(assert|expect)$/.test(v) && (slice[index + 1] === "." || slice[index + 1] === "("),
            )
        )
          add(key, i, "process.exit before assertions");
      }
      if (
        t[i] === "pytest" &&
        t[i + 1] === "." &&
        ((t[i + 2] === "skip" && t[i + 3] === "(") ||
          (t[i + 2] === "mark" && t[i + 3] === "." && t[i + 4] === "skip"))
      )
        add(key, i, "pytest skip");
      if (t[i] === "pytestmark" && t[i + 1] === "=") add(key, i, "pytestmark");
    }
    return { tokens, registrations, findings };
  };
  const base = inspect(baseText);
  const next = inspect(newText);
  const existing = new Set(base.registrations.map((r) => r.key));
  const remaining = base.findings.map((f) => f.key);
  return next.findings
    .filter((finding) => {
      const registration = next.registrations.find((r) => r.start <= finding.index && finding.index <= r.end);
      if (registration && !existing.has(registration.key)) return false;
      const index = remaining.indexOf(finding.key);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    })
    .map((finding) => ({
      line: newText.slice(0, next.tokens[finding.index].offset).split("\n").length,
      reason: finding.reason,
    }));
}
