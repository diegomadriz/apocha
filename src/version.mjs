// @ts-check
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Name and version of this package, recorded in receipts and run metadata. */
export const GENERATOR = Object.freeze({ name: String(pkg.name), version: String(pkg.version) });
