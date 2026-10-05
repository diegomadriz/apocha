// @ts-check

/**
 * Longest valid UTF-8 prefix of `value` that fits in `maxBytes`.
 * @param {string} value
 * @param {number} maxBytes
 */
export function utf8Prefix(value, maxBytes) {
  const text = typeof value === "string" ? value : "";
  if (maxBytes <= 0 || !text) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Longest valid UTF-8 suffix of `value` that fits in `maxBytes`.
 * @param {string} value
 * @param {number} maxBytes
 */
export function utf8Suffix(value, maxBytes) {
  const text = typeof value === "string" ? value : "";
  if (maxBytes <= 0 || !text) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/**
 * Decode captured process output, dropping a trailing partial UTF-8 sequence.
 * @param {Buffer} buffer
 */
export function decodeCaptured(buffer) {
  let end = buffer.length;
  // Step back over continuation bytes and the lead byte of an incomplete sequence.
  let back = 0;
  while (back < 4 && end - back - 1 >= 0 && (buffer[end - back - 1] & 0xc0) === 0x80) back += 1;
  const lead = end - back - 1;
  if (lead >= 0) {
    const byte = buffer[lead];
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (expected > back + 1) end = lead;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Lines that usually locate a failure in compiler, linter, and test output.
 * Kept ahead of truncation so a repair round sees where the error is.
 */
const FAILURE_SIGNAL =
  /^\s*[×✗✖]|FAIL|not ok|AssertionError|SyntaxError|TypeError|ReferenceError|Error:|error TS\d+|E\s{3}|Traceback|[^\s:()]+:\d+(?::\d+)?|[^\s()]+\(\d+,\d+\)/;

/** @param {string} value */
export function failureSignalLines(value) {
  const seen = new Set();
  const lines = [];
  for (const line of (typeof value === "string" ? value : "").split(/\r?\n/)) {
    if (!FAILURE_SIGNAL.test(line)) continue;
    const bounded = utf8Prefix(line, 300);
    if (!seen.has(bounded)) {
      seen.add(bounded);
      lines.push(bounded);
    }
  }
  return lines;
}

/**
 * Fit `value` into `budget` bytes, keeping failure-signal lines first and the
 * tail of the output after them.
 * @param {string} value
 * @param {number} budget
 */
export function failureFirst(value, budget) {
  if (Buffer.byteLength(value) <= budget) return value;
  if (budget < 16) return utf8Suffix(value, budget);
  const signalBudget = Math.floor(budget * 0.6);
  const kept = [];
  let used = 0;
  for (const line of failureSignalLines(value)) {
    const size = Buffer.byteLength(line) + 1;
    if (used + size > signalBudget) continue;
    kept.push(line);
    used += size;
  }
  const head = kept.length ? `${kept.join("\n")}\n...\n` : "...\n";
  return head + utf8Suffix(value, budget - Buffer.byteLength(head));
}
