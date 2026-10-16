// @ts-check
import { HarnessError, isObject } from "../util/errors.mjs";
import { commitIdentity, git, OID } from "../util/git.mjs";
import { loadSchema, validateAgainst } from "../util/schema.mjs";
import { digestBetweenCommits } from "./candidate.mjs";
import { allowedSignersAt, signReceipt, verifySignature } from "./signatures.mjs";

/**
 * Receipts are Git notes on promoted commits. A receipt says which candidate
 * was verified (content digest), by which checks and configuration, who
 * reviewed it, and which runtimes ran. `verifyReceipt` checks it against Git
 * alone: commit identity, parents, and a recomputed candidate digest.
 *
 * Version 3 is written by Apocha. Version 3 receipts written before the rename
 * from Panagent carry `panagent.receipt.v3`, and versions 1 and 2 (written by
 * the harness Apocha was extracted from) are still verified, so existing history lands.
 */

export const RECEIPT_SCHEMA = "apocha.receipt.v3";
/** Schema ids of version 3 receipts written under the project's earlier name. */
export const LEGACY_RECEIPT_SCHEMAS = Object.freeze(["panagent.receipt.v3"]);

const NOTE_ENV = {
  GIT_AUTHOR_NAME: "apocha",
  GIT_AUTHOR_EMAIL: "apocha@localhost",
  GIT_COMMITTER_NAME: "apocha",
  GIT_COMMITTER_EMAIL: "apocha@localhost",
};

const LEGACY_V1 = [
  "version",
  "task_id",
  "promoted_head",
  "tree",
  "parents",
  "base_commit",
  "candidate_digest",
  "checks",
  "review_decision",
  "repair_attempts",
  "implementer_invocations",
  "runtimes",
];
const LEGACY_V2 = [...LEGACY_V1, "governance_edits_allowed"];

/** @param {Record<string, unknown>} value @param {string[]} fields */
function exactFields(value, fields) {
  return (
    isObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

/** @param {any} receipt @returns {string | null} */
function legacyViolation(receipt) {
  // Some version-1 receipts written during the v1 -> v2 transition already carry the v2 governance field.
  const shapes = receipt.version === 1 ? [LEGACY_V1, LEGACY_V2] : [LEGACY_V2];
  if (!shapes.some((fields) => exactFields(receipt, fields)))
    return "legacy receipt fields are incomplete or extra";
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(receipt.task_id)) return "invalid task_id";
  for (const field of ["promoted_head", "tree", "base_commit"])
    if (!OID.test(receipt[field])) return `invalid ${field}`;
  if (
    !Array.isArray(receipt.parents) ||
    !receipt.parents.length ||
    receipt.parents.some((parent) => !OID.test(parent))
  )
    return "invalid parents";
  if (!/^[0-9a-f]{64}$/.test(receipt.candidate_digest)) return "invalid candidate_digest";
  if (
    !Array.isArray(receipt.checks) ||
    !receipt.checks.length ||
    receipt.checks.some((check) => check?.status !== "pass")
  )
    return "checks are not all pass";
  if (receipt.review_decision !== "PASS") return "review decision is not PASS";
  if (
    !Number.isInteger(receipt.repair_attempts) ||
    receipt.repair_attempts < 0 ||
    receipt.repair_attempts > 2
  )
    return "invalid repair_attempts";
  if (
    Object.hasOwn(receipt, "governance_edits_allowed") &&
    typeof receipt.governance_edits_allowed !== "boolean"
  )
    return "invalid governance_edits_allowed";
  return null;
}

/**
 * @param {string} repositoryRoot
 * @param {string} notesRef
 * @param {Record<string, unknown>} receipt a v3 receipt
 * @param {{ key: string, principal: string }} [signing]
 */
export function writeReceipt(repositoryRoot, notesRef, receipt, signing) {
  if (signing) receipt = signReceipt(receipt, signing);
  const errors = validateAgainst(loadSchema("receipt-v3.schema.json"), receipt);
  if (errors.length)
    throw new HarnessError(
      "integrity",
      "invalid_receipt",
      `receipt is invalid: ${errors.slice(0, 3).join("; ")}`,
    );
  const commit = /** @type {string} */ (receipt.promoted_head);
  commitIdentity(repositoryRoot, commit);
  const existing = git(repositoryRoot, ["notes", `--ref=${notesRef}`, "show", commit], {
    allowFailure: true,
  });
  if (existing.status === 0)
    throw new HarnessError(
      "integrity",
      "receipt_exists",
      `a receipt already exists for ${commit}: another run already produced and receipted this exact commit; two runs making the identical change with the same message in the same second produce the same commit; the existing receipt still covers it`,
    );
  git(repositoryRoot, ["notes", `--ref=${notesRef}`, "add", "-F", "-", commit], {
    input: `${JSON.stringify(receipt)}\n`,
    env: NOTE_ENV,
  });
  return receipt;
}

/** @param {string} repositoryRoot @param {string} notesRef @param {string} commit */
export function readReceipt(repositoryRoot, notesRef, commit) {
  const note = git(repositoryRoot, ["notes", `--ref=${notesRef}`, "show", commit], { allowFailure: true });
  if (note.status !== 0) return null;
  return JSON.parse(String(note.stdout));
}

/**
 * @param {string} repositoryRoot
 * @param {string} notesRef
 * @param {string} commit full OID
 * @param {string} [allowedSignersCommit] Git tree supplying trusted signers
 * @param {string} [allowedSignersFile] repository-relative path
 * @returns {{ valid: boolean, reason: string | null, receipt: any, version: number | null, signature: import("./signatures.mjs").SignatureStatus }}
 */
export function verifyReceipt(
  repositoryRoot,
  notesRef,
  commit,
  allowedSignersCommit = "HEAD",
  allowedSignersFile = ".apocha/allowed_signers",
) {
  /** @type {import("./signatures.mjs").SignatureStatus} */
  let signature = { status: "unsigned", principal: null };
  let receipt;
  let actual;
  try {
    actual = commitIdentity(repositoryRoot, commit);
    receipt = readReceipt(repositoryRoot, notesRef, commit);
    if (receipt === null)
      return { valid: false, reason: "missing receipt", receipt: null, version: null, signature };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "malformed receipt JSON" : error.message;
    return { valid: false, reason, receipt: null, version: null, signature };
  }
  signature = verifySignature(
    receipt ?? {},
    allowedSignersAt(repositoryRoot, allowedSignersCommit, allowedSignersFile),
  );
  const version =
    receipt?.schema === RECEIPT_SCHEMA || LEGACY_RECEIPT_SCHEMAS.includes(receipt?.schema)
      ? 3
      : receipt?.version === 1 || receipt?.version === 2
        ? receipt.version
        : null;
  const invalid = (reason) => ({ valid: false, reason, receipt, version, signature });
  if (version === null) return invalid("unsupported receipt version");
  if (version === 3) {
    const errors = validateAgainst(loadSchema("receipt-v3.schema.json"), receipt);
    if (errors.length) return invalid(`receipt schema: ${errors.slice(0, 3).join("; ")}`);
  } else {
    const violation = legacyViolation(receipt);
    if (violation) return invalid(violation);
  }
  if (receipt.judge_inputs) {
    const paths = new Set(receipt.judge_inputs.changes.map((change) => change.path));
    if (receipt.judge_inputs.verdicts) {
      for (const path of paths)
        if (
          !receipt.judge_inputs.verdicts.some((entry) => entry.path === path && entry.verdict === "justified")
        )
          return invalid(`judge_inputs missing justified verdict for: ${path}`);
    }
    for (const restored of receipt.judge_inputs.base_judge.restored)
      if (!paths.has(restored))
        return invalid(`judge_inputs restored path is missing from changes: ${restored}`);
  }
  if (receipt.promoted_head !== commit) return invalid("promoted_head does not match the commit");
  if (receipt.tree !== actual.tree) return invalid("tree does not match the commit");
  if (
    receipt.parents.length !== actual.parents.length ||
    receipt.parents.some((parent, index) => parent !== actual.parents[index])
  ) {
    return invalid("parents do not match the commit");
  }
  if (receipt.base_commit !== actual.parents[0]) return invalid("base_commit is not the first parent");
  const recomputed = digestBetweenCommits(repositoryRoot, receipt.base_commit, commit);
  if (recomputed !== receipt.candidate_digest)
    return invalid("candidate_digest does not match the commit's change");
  if (signature.status === "invalid" || signature.status === "unknown_signer")
    return invalid(`receipt signature: ${signature.status}`);
  return { valid: true, reason: null, receipt, version, signature };
}
