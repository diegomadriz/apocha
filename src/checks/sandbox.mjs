// @ts-check

/** @param {import("../core/context.mjs").RunContext} ctx */
export function warnCatalogUnsandboxedChecks(ctx) {
  for (const id of ctx.task.checks) {
    if (!ctx.config.checks[id].unsandboxed) continue;
    ctx.event("sandbox.warning", {
      reason: "check_unsandboxed",
      check_id: id,
      message: `check ${id} will execute without an OS sandbox (unsandboxed: true in the project catalog)`,
    });
  }
}
