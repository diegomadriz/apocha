// @ts-check

/**
 * Error classes the controller understands. Every failure that crosses a module
 * boundary carries one, so run outcomes and metrics can tell harness failures
 * from model failures.
 *
 * - `config`: invalid task, config, or CLI input. Never retried.
 * - `infra`: the harness or host failed (git, filesystem, process spawn, timeout).
 * - `provider`: the model provider returned an error.
 * - `usage_limited`: the runtime hit a subscription or rate limit. The run pauses.
 * - `agent`: the agent misbehaved (no result, invalid result, gave up).
 * - `tool_protocol`: the runtime and the tool server disagreed about a call.
 * - `policy_violation`: the runtime used a capability outside the harness tools.
 * - `integrity`: evidence no longer matches the candidate (stale digest, tampering).
 */
export const ERROR_CLASSES = Object.freeze([
  "config",
  "infra",
  "provider",
  "usage_limited",
  "agent",
  "tool_protocol",
  "policy_violation",
  "integrity",
]);

export class HarnessError extends Error {
  /**
   * @param {string} errorClass one of ERROR_CLASSES
   * @param {string} code short snake_case code
   * @param {string} message human-readable, bounded, never contains prompt text
   * @param {{ cause?: unknown, details?: Record<string, unknown>, retryAfter?: string | null }} [options]
   */
  constructor(errorClass, code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (!ERROR_CLASSES.includes(errorClass)) throw new TypeError(`unknown error class: ${errorClass}`);
    this.name = "HarnessError";
    this.errorClass = errorClass;
    this.code = code;
    this.details = options.details ?? {};
    this.retryAfter = options.retryAfter ?? null;
  }
}

/** @param {unknown} error */
export function isHarnessError(error) {
  return error instanceof HarnessError;
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @param {string} [errorClass]
 * @param {string} [code]
 * @returns {asserts condition}
 */
export function assert(condition, message, errorClass = "config", code = "invalid") {
  if (!condition) throw new HarnessError(errorClass, code, message);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize any thrown value into a plain record for events and reports.
 * @param {unknown} error
 */
export function describeError(error) {
  if (error instanceof HarnessError) {
    return {
      error_class: error.errorClass,
      code: error.code,
      message: error.message,
      ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error_class: "infra", code: "unexpected", message };
}
