// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BUDGETS, normalizeRuntimeConfig, roleProvider } from "../src/config/runtime.mjs";

/** @param {Record<string, unknown>} [role] */
function config(role = {}) {
  return {
    version: 1,
    roles: {
      implementer: { adapter: "opencode", model: "openai/test-model", ...role },
      reviewer: { adapter: "fake" },
    },
    adapters: { opencode: { command: "opencode-test", min_version: "1.2.3" } },
  };
}

test("opencode config preserves model, variant, effort, adapter settings and stable digests", () => {
  const raw = config({ variant: "reasoning", effort: "high" });
  const normalized = normalizeRuntimeConfig(raw, "first.json");
  assert.deepEqual(normalized.roles, raw.roles);
  assert.deepEqual(normalized.adapters, raw.adapters);
  assert.deepEqual(normalized.budgets, DEFAULT_BUDGETS);
  assert.deepEqual(normalized.retry, { infra: 1 });
  assert.equal(normalized.source, "first.json");
  assert.match(normalized.digest, /^[0-9a-f]{64}$/);
  assert.equal(normalized.digest, normalizeRuntimeConfig(raw, "second.json").digest);
  assert.equal(
    normalized.digest,
    normalizeRuntimeConfig({ ...raw, budgets: DEFAULT_BUDGETS, retry: { infra: 1 } }, "x").digest,
  );
  for (const change of [{ model: "anthropic/test" }, { variant: "other" }, { effort: "low" }]) {
    assert.notEqual(
      normalized.digest,
      normalizeRuntimeConfig(config({ ...raw.roles.implementer, ...change }), "x").digest,
    );
  }
  assert.notEqual(
    normalized.digest,
    normalizeRuntimeConfig({ ...raw, adapters: { opencode: { command: "other" } } }, "x").digest,
  );
  assert.equal(normalizeRuntimeConfig(config(), "x").roles.implementer.variant, undefined);
  for (const variant of ["a", "v".repeat(100)]) {
    assert.equal(normalizeRuntimeConfig(config({ variant }), "x").roles.implementer.variant, variant);
  }
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(normalizeRuntimeConfig(config({ effort }), "x").roles.implementer.effort, effort);
  }
  assert.deepEqual(raw, config({ variant: "reasoning", effort: "high" }));
});

test("opencode rejects missing models, malformed settings and unknown config fields", () => {
  for (const role of ["implementer", "reviewer"]) {
    const raw = config();
    raw.roles[role] = { adapter: "opencode" };
    assert.throws(() => normalizeRuntimeConfig(raw, "x"), /model is required for opencode/);
  }
  for (const model of ["", 42, null]) {
    assert.throws(() => normalizeRuntimeConfig(config({ model }), "x"));
  }
  for (const variant of ["", "v".repeat(101), 42, null, {}, []]) {
    assert.throws(() => normalizeRuntimeConfig(config({ variant }), "x"));
  }
  assert.throws(() => normalizeRuntimeConfig(config({ effort: "invalid" }), "x"));
  for (const settings of [
    { command: "" },
    { command: 42 },
    { command: "c".repeat(1001) },
    { min_version: "1.2" },
    { min_version: 123 },
    { extra: true },
  ]) {
    assert.throws(() => normalizeRuntimeConfig({ ...config(), adapters: { opencode: settings } }, "x"));
  }
  for (const raw of [
    { ...config(), extra: true },
    config({ extra: true }),
    { ...config(), roles: { ...config().roles, extra: { adapter: "fake" } } },
    { ...config(), adapters: { extra: {} } },
  ]) {
    assert.throws(() => normalizeRuntimeConfig(raw, "x"), /is not allowed/);
  }
});

test("variant is rejected semantically for every existing adapter in either role", () => {
  for (const adapter of ["codex", "claude-code", "pi", "fake"]) {
    for (const role of ["implementer", "reviewer"]) {
      const raw = config();
      raw.roles[role] = { adapter, model: "test", variant: "reasoning" };
      assert.throws(
        () => normalizeRuntimeConfig(raw, "x"),
        (error) => error.errorClass === "config" && error.code === "variant_not_supported",
      );
      delete raw.roles[role].variant;
      assert.equal(normalizeRuntimeConfig(raw, "x").roles[role].adapter, adapter);
    }
  }
});

test("opencode provider identity is the actual vendor, with explicit settings taking precedence", () => {
  for (const [model, expected] of [
    ["openai/test", "openai"],
    ["openai-codex/test", "openai"],
    ["anthropic/test", "anthropic"],
    ["google/test", "google"],
    ["other-vendor/test", "other-vendor"],
  ]) {
    assert.equal(roleProvider({ adapter: "opencode", model }), expected);
    assert.equal(roleProvider({ adapter: "opencode", model, provider: "google" }), "google");
    assert.equal(roleProvider({ adapter: "opencode", model }, { provider: "anthropic" }), "anthropic");
  }
  for (const model of ["opencode/test-free", "openai/test", "unqualified"]) {
    assert.equal(roleProvider({ adapter: "opencode", model, provider: "openai-codex" }), "openai");
    assert.equal(roleProvider({ adapter: "opencode", model }, { provider: "openai-codex" }), "openai");
    assert.equal(
      roleProvider({ adapter: "opencode", model, provider: "anthropic" }, { provider: "openai" }),
      "anthropic",
    );
  }
});

test("gateway and ambiguous model identities stay unknown, never opencode", () => {
  for (const model of [
    undefined,
    "unqualified",
    "opencode/test-free",
    "opencode/openai/test",
    "/test",
    "openai/",
  ]) {
    const provider = roleProvider({ adapter: "opencode", model });
    assert.equal(provider, "unknown");
    assert.notEqual(provider, "opencode");
  }
  assert.equal(roleProvider({ adapter: "opencode", model: "opencode/test", provider: "unknown" }), "unknown");
  assert.equal(roleProvider({ adapter: "opencode", provider: "opencode" }), "unknown");
  assert.equal(roleProvider({ adapter: "opencode" }, { provider: "opencode" }), "unknown");
  assert.equal(roleProvider({ adapter: "pi" }), "unknown");
  assert.equal(roleProvider({ adapter: "pi", provider: "openai-codex" }), "openai");
  assert.equal(roleProvider({ adapter: "codex" }), "openai");
  assert.equal(roleProvider({ adapter: "claude-code" }), "anthropic");
  assert.equal(roleProvider({ adapter: "fake" }), "fake");
});
