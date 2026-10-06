// @ts-check
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../util/digest.mjs";
import { HarnessError } from "../util/errors.mjs";
import { git } from "../util/git.mjs";

const NAMESPACE = "apocha-receipt";

/** @param {Record<string, unknown>} receipt */
function signedData(receipt) {
  const { signature: _signature, ...data } = receipt;
  return canonicalJson(data);
}

/** @param {Record<string, unknown>} receipt @param {{ key: string, principal: string }} signing */
export function signReceipt(receipt, signing) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "apocha-sign-"));
  try {
    // With stdin, ssh-keygen writes the armored signature to stdout.
    const result = spawnSync("ssh-keygen", ["-Y", "sign", "-f", signing.key, "-n", NAMESPACE], {
      cwd: directory,
      input: signedData(receipt),
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.error || result.status !== 0)
      throw new HarnessError("infra", "signing_failed", "ssh-keygen could not sign the receipt");
    return {
      ...receipt,
      signature: {
        format: "ssh",
        namespace: NAMESPACE,
        principal: signing.principal,
        signature: result.stdout,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {string} commit
 * @param {string} file
 */
export function allowedSignersAt(root, commit, file) {
  const result = git(root, ["show", `${commit}:${file}`], { allowFailure: true });
  return result.status === 0 ? String(result.stdout) : "";
}

/**
 * @typedef {{ status: "valid" | "unsigned" | "invalid" | "unknown_signer", principal: string | null }} SignatureStatus
 * @param {Record<string, any>} receipt
 * @param {string} allowedSigners
 * @returns {SignatureStatus}
 */
export function verifySignature(receipt, allowedSigners) {
  if (!Object.hasOwn(receipt, "signature")) return { status: "unsigned", principal: null };
  const signature = receipt.signature;
  const principal = typeof signature?.principal === "string" ? signature.principal : null;
  if (
    signature?.format !== "ssh" ||
    signature?.namespace !== NAMESPACE ||
    !principal ||
    typeof signature?.signature !== "string"
  )
    return { status: "invalid", principal };
  const directory = mkdtempSync(path.join(os.tmpdir(), "apocha-verify-"));
  try {
    const signers = path.join(directory, "allowed_signers");
    const sigfile = path.join(directory, "signature");
    writeFileSync(signers, allowedSigners, { mode: 0o600 });
    writeFileSync(sigfile, signature.signature, { mode: 0o600 });
    const result = spawnSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", signers, "-I", principal, "-n", NAMESPACE, "-s", sigfile],
      { input: signedData(receipt), encoding: "utf8", timeout: 30000 },
    );
    if (!result.error && result.status === 0) return { status: "valid", principal };
    const known = spawnSync("ssh-keygen", ["-Y", "find-principals", "-f", signers, "-s", sigfile], {
      encoding: "utf8",
      timeout: 30000,
    });
    return {
      status: !known.error && known.status !== 0 ? "unknown_signer" : "invalid",
      principal,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** @param {{ key: string, principal: string }} signing @param {string} allowedSigners */
export function signingKeyAllowed(signing, allowedSigners) {
  const signature = signReceipt({}, signing);
  return verifySignature(signature, allowedSigners).status === "valid";
}
