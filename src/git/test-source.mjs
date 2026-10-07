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
  const bypasses = (source) => sourceTokens(source).filter((token) => /^(return|skip|only)$/.test(token));
  return (
    assertions(base).every((call) => {
      const index = remaining.indexOf(call);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    }) && bypasses(next).length <= bypasses(base).length
  );
}
