// @ts-check
import { readFileSync } from "node:fs";
import { HarnessError, isObject } from "./errors.mjs";

/**
 * A small validator for the JSON Schema (2020-12) subset Apocha's schemas use:
 * type, properties, required, additionalProperties, items, enum, const,
 * pattern, minLength/maxLength, minItems/maxItems, uniqueItems,
 * minimum/maximum, propertyNames, and local `$ref` into `$defs`.
 *
 * The schema files in `schemas/` are the single source of truth for every
 * document shape; code adds only semantic checks the schema cannot express.
 * Unsupported keywords throw, so a schema can never silently weaken.
 */
const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "propertyNames",
]);

/** @param {unknown} value */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * @param {Record<string, any>} root
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @param {string} at
 * @param {string[]} errors
 */
function check(root, schema, value, at, errors) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`schema keyword not supported by validator: ${key}`);
  }
  if (schema.$ref) {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref);
    if (!match || !root.$defs?.[match[1]]) throw new Error(`unresolvable $ref: ${schema.$ref}`);
    check(root, root.$defs[match[1]], value, at, errors);
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${at || "/"} must be ${allowed.join(" or ")}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const)
    errors.push(`${at || "/"} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value))
    errors.push(`${at || "/"} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at} is too short`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${at} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${at} allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${at} contains duplicates`);
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) check(root, schema.items, item, `${at}/${index}`, errors);
    }
  }
  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${at}/${name} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      const where = `${at}/${name}`;
      if (schema.propertyNames) check(root, schema.propertyNames, name, `${where} (name)`, errors);
      if (schema.properties && Object.hasOwn(schema.properties, name)) {
        check(root, schema.properties[name], child, where, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${where} is not allowed`);
      } else if (isObject(schema.additionalProperties)) {
        check(root, schema.additionalProperties, child, where, errors);
      }
    }
  }
}

/**
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @returns {string[]} error messages, empty when valid
 */
export function validateAgainst(schema, value) {
  /** @type {string[]} */
  const errors = [];
  check(schema, schema, value, "", errors);
  return errors;
}

const cache = new Map();

/**
 * Load a schema shipped in `schemas/`.
 * @param {string} name file name without directory, e.g. "task.schema.json"
 */
export function loadSchema(name) {
  if (!cache.has(name)) {
    const url = new URL(`../../schemas/${name}`, import.meta.url);
    cache.set(name, JSON.parse(readFileSync(url, "utf8")));
  }
  return cache.get(name);
}

/**
 * Validate and throw a `config` HarnessError listing the first problems.
 * @param {string} schemaName
 * @param {unknown} value
 * @param {string} label
 */
export function assertValid(schemaName, value, label) {
  const errors = validateAgainst(loadSchema(schemaName), value);
  if (errors.length) {
    const shown = errors.slice(0, 8).join("; ");
    throw new HarnessError("config", "schema_violation", `${label} is invalid: ${shown}`);
  }
}
