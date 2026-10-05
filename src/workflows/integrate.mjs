// @ts-check

/**
 * Integration: merge a topic onto a base in a fresh candidate, then verify,
 * review, and promote the merged tree with the topic as a second parent.
 * The implementer is only called to repair a merged tree that fails.
 *
 * @type {import("../core/workflow.mjs").WorkflowDefinition}
 */
export default {
  id: "integrate",
  version: 1,
  description: "Merge a topic onto a base, verify and review the merged tree, and promote it.",
  start: "merge",
  stages: {
    merge: { kind: "seed", on: { done: "verify", conflict: "ESCALATED", empty: "FAILED" } },
    verify: {
      kind: "checks",
      on: { pass: "review", fail: "repair", violation: "FAILED", infra_error: "ESCALATED" },
    },
    repair: { kind: "budget", counter: "repairs", on: { available: "implement", exhausted: "ESCALATED" } },
    implement: { kind: "agent", role: "implementer", on: { done: "verify", no_changes: "ESCALATED" } },
    review: {
      kind: "review",
      role: "reviewer",
      on: { PASS: "promote", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" },
    },
    promote: { kind: "promote", on: { done: "PASSED" } },
  },
};
