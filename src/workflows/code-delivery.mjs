// @ts-check

/**
 * Code delivery: implement, verify with the task's checks, review
 * independently, and promote. Failed checks and reviewer findings go back to
 * the implementer while the repair budget lasts.
 *
 * @type {import("../core/workflow.mjs").WorkflowDefinition}
 */
export default {
  id: "code-delivery",
  version: 1,
  description:
    "Implement a task, verify it with named checks, review it independently, and promote it with a receipt.",
  start: "implement",
  stages: {
    implement: {
      kind: "agent",
      role: "implementer",
      on: { done: "verify", no_changes: "ESCALATED", blocked: "blocked-review" },
    },
    verify: {
      kind: "checks",
      on: { pass: "review", fail: "repair", violation: "FAILED", infra_error: "ESCALATED" },
    },
    repair: { kind: "budget", counter: "repairs", on: { available: "implement", exhausted: "ESCALATED" } },
    "blocked-review": {
      kind: "review",
      role: "reviewer",
      mode: "blocked-claim",
      on: { PASS: "repair", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" },
    },
    review: {
      kind: "review",
      role: "reviewer",
      on: { PASS: "promote", FIX: "repair", ESCALATE: "ESCALATED", too_large: "ESCALATED" },
    },
    promote: { kind: "promote", on: { done: "PASSED" } },
  },
};
