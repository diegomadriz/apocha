// @ts-check
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory name prefix for every temporary directory Apocha creates. */
export const TEMP_PREFIX = "apocha-";

/** @typedef {{ kind: string, run_id: string | null, pid: number, created_at: string, repository?: string }} TempOwner */

/** @param {string} kind @param {{ runId?: string, repository?: string }} [options] */
export function makeTempDir(kind, { runId, repository } = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(kind)) throw new Error("invalid temp directory kind");
  const dir = mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${kind}-`));
  try {
    const root = realpathSync(dir);
    writeFileSync(
      path.join(root, ".apocha-owner"),
      JSON.stringify({
        kind,
        run_id: runId ?? null,
        pid: process.pid,
        created_at: new Date().toISOString(),
        ...(repository === undefined ? {} : { repository: realpathSync(repository) }),
      }),
    );
    return root;
  } catch (error) {
    removeTempDir(dir);
    throw error;
  }
}

/** @param {string} dir */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** @returns {{ path: string, kind: string, owner: TempOwner | null }[]} */
export function listTempDirs() {
  return readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX))
    .map((entry) => {
      const dir = path.join(os.tmpdir(), entry.name);
      /** @type {TempOwner | null} */
      let owner = null;
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, ".apocha-owner"), "utf8"));
        if (
          parsed &&
          typeof parsed.kind === "string" &&
          (parsed.run_id === null || typeof parsed.run_id === "string") &&
          typeof parsed.pid === "number" &&
          typeof parsed.created_at === "string" &&
          (parsed.repository === undefined || typeof parsed.repository === "string")
        )
          owner = parsed;
      } catch {
        // Legacy directories and unreadable markers still appear in the inventory.
      }
      return {
        path: dir,
        kind: owner?.kind ?? entry.name.slice(TEMP_PREFIX.length).replace(/-[^-]+$/, ""),
        owner,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
