// @ts-check
import { createHash } from "node:crypto";

/** @param {string | Buffer} value */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * Used wherever a value is hashed, so digests do not depend on key order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** @param {unknown} value */
export function digestJson(value) {
  return sha256(canonicalJson(value));
}
