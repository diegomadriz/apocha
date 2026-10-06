// @ts-check
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { HarnessError } from "../util/errors.mjs";
import { gitBuffer } from "../util/git.mjs";
import { isInside } from "../util/paths.mjs";

/**
 * Dependency policies decide what a check may use besides the candidate's
 * tracked files.
 *
 * - `none`: nothing is added. Toolchains come from the host (for example a
 *   venv referenced with `{source}` in the check's argv).
 * - `npm`: `node_modules` is copied from the source checkout, but only when
 *   `package.json` and `package-lock.json` are byte-identical across the base
 *   commit, the candidate, and the source checkout, and every direct dependency
 *   is installed at its locked version. A candidate can therefore never change
 *   what gets installed (dependency changes need a human).
 */

/** @param {string} root @param {string} label */
function assertContainedSymlinks(root, label) {
  if (lstatSync(root).isSymbolicLink())
    throw new HarnessError("integrity", "dependency_symlink", `${label} node_modules is a symlink`);
  const treeRoot = realpathSync(root);
  const pending = [root];
  while (pending.length) {
    const directory = /** @type {string} */ (pending.pop());
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (path.isAbsolute(target))
          throw new HarnessError(
            "integrity",
            "dependency_symlink",
            `${label} dependency symlink is absolute`,
          );
        let resolved;
        try {
          resolved = realpathSync(path.resolve(path.dirname(absolute), target));
        } catch {
          throw new HarnessError("integrity", "dependency_symlink", `${label} dependency symlink is broken`);
        }
        if (!isInside(resolved, treeRoot))
          throw new HarnessError(
            "integrity",
            "dependency_symlink",
            `${label} dependency symlink escapes the tree`,
          );
      } else if (stat.isDirectory()) {
        pending.push(absolute);
      }
    }
  }
}

/** @param {string} root @param {string} cwd @param {string} name */
function fileAt(root, cwd, name) {
  const file = path.resolve(root, cwd, name);
  return existsSync(file) ? readFileSync(file) : null;
}

/** @param {string} candidateRoot @param {string} baseCommit @param {string} cwd @param {string} name */
function baseFile(candidateRoot, baseCommit, cwd, name) {
  const relative = path.posix.join(cwd, name);
  const listed = gitBuffer(candidateRoot, ["ls-tree", "-z", baseCommit, "--", relative]);
  if (!listed.length) return null;
  return gitBuffer(candidateRoot, ["show", `${baseCommit}:${relative}`]);
}

/** @param {Buffer | null} a @param {Buffer | null} b */
function sameBytes(a, b) {
  return a === null ? b === null : b !== null && a.equals(b);
}

/**
 * Successful validations belong to a candidate's run, not the process or checkout.
 * @typedef {{ fingerprint: string, manifest: Buffer | null, lock: Buffer | null }} DependencyValidation
 * @typedef {{ entries: Map<string, DependencyValidation> }} DependencyCache
 * @typedef {{ cache?: DependencyCache, copyCommand?: string, onValidation?: (source: string) => void, onCopied?: (method: "command" | "fallback") => void }} DependencyOptions
 */

/** @type {WeakMap<object, DependencyCache>} */
const runCaches = new WeakMap();

/** @param {object} candidate @returns {DependencyCache} */
export function dependencyCacheFor(candidate) {
  let cache = runCaches.get(candidate);
  if (!cache) {
    cache = { entries: new Map() };
    runCaches.set(candidate, cache);
  }
  return cache;
}

/** @param {(Buffer | null)[]} inputs */
function fingerprint(inputs) {
  const hash = createHash("sha256");
  for (const bytes of inputs) {
    hash.update(bytes === null ? "missing:" : `${bytes.length}:`);
    if (bytes) hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Verify the npm dependency contract and copy node_modules into the exec root.
 * @param {{ candidateRoot: string, sourceRoot: string, baseCommit: string, cwd: string, execCwd: string, options?: DependencyOptions }} input
 */
export function prepareNpmDependencies({
  candidateRoot,
  sourceRoot,
  baseCommit,
  cwd,
  execCwd,
  options = {},
}) {
  const source = path.resolve(sourceRoot, cwd, "node_modules");
  if (!existsSync(source))
    throw new HarnessError("infra", "dependencies_missing", `node_modules is not installed in ${cwd}`);
  const manifest = fileAt(candidateRoot, cwd, "package.json");
  const lock = fileAt(candidateRoot, cwd, "package-lock.json");
  const sourceManifest = fileAt(sourceRoot, cwd, "package.json");
  const sourceLock = fileAt(sourceRoot, cwd, "package-lock.json");
  const sourceFingerprint = fingerprint([
    sourceManifest,
    sourceLock,
    fileAt(source, ".", ".package-lock.json"),
  ]);
  const key = JSON.stringify([source, baseCommit]);
  const cached = options.cache?.entries.get(key);
  if (
    cached?.fingerprint === sourceFingerprint &&
    sameBytes(manifest, cached.manifest) &&
    sameBytes(lock, cached.lock)
  ) {
    return copyDependencies(source, execCwd, options);
  }
  // Never retain a previous success after an invalidated validation fails.
  options.cache?.entries.delete(key);
  options.onValidation?.(source);
  for (const name of ["package.json", "package-lock.json"]) {
    const candidateBytes = fileAt(candidateRoot, cwd, name);
    if (!sameBytes(candidateBytes, baseFile(candidateRoot, baseCommit, cwd, name))) {
      throw new HarnessError(
        "integrity",
        "dependency_contract",
        `${path.posix.join(cwd, name)} differs from the base commit`,
      );
    }
    if (!sameBytes(candidateBytes, fileAt(sourceRoot, cwd, name))) {
      throw new HarnessError(
        "infra",
        "dependency_contract",
        `source checkout ${name} differs from the candidate; reinstall or sync the checkout`,
      );
    }
  }
  if (manifest) {
    const pkg = JSON.parse(manifest.toString("utf8"));
    const direct = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    if (Object.keys(direct).length) {
      if (!lock)
        throw new HarnessError(
          "integrity",
          "dependency_contract",
          "package-lock.json is required for npm dependencies",
        );
      const locked = JSON.parse(lock.toString("utf8"));
      const rootEntry = locked.packages?.[""] ?? {};
      for (const [name, spec] of Object.entries(direct)) {
        const entry = locked.packages?.[`node_modules/${name}`];
        const rootSpec =
          rootEntry.dependencies?.[name] ??
          rootEntry.devDependencies?.[name] ??
          rootEntry.optionalDependencies?.[name];
        if (!entry?.version || rootSpec !== spec) {
          throw new HarnessError(
            "integrity",
            "dependency_contract",
            `lockfile does not pin direct dependency ${name}`,
          );
        }
        const installedFile = path.join(source, ...name.split("/"), "package.json");
        if (!existsSync(installedFile))
          throw new HarnessError("infra", "dependencies_stale", `installed dependency ${name} is missing`);
        const installed = JSON.parse(readFileSync(installedFile, "utf8"));
        if (installed.name !== name || installed.version !== entry.version) {
          throw new HarnessError(
            "infra",
            "dependencies_stale",
            `installed dependency ${name} is ${installed.version}, lock says ${entry.version}`,
          );
        }
      }
    }
  }
  assertContainedSymlinks(source, "source");
  options.cache?.entries.set(key, { fingerprint: sourceFingerprint, manifest, lock });
  return copyDependencies(source, execCwd, options);
}

/** @param {string} source @param {string} execCwd @param {DependencyOptions} options */
function copyDependencies(source, execCwd, options) {
  const target = path.resolve(execCwd, "node_modules");
  if (existsSync(target))
    throw new HarnessError("integrity", "dependency_contract", "candidate already contains node_modules");
  const args =
    process.platform === "darwin"
      ? ["-c", "-R", source, target]
      : process.platform === "linux"
        ? ["-R", "--reflink=auto", "--no-dereference", "--preserve=links", source, target]
        : null;
  const copied = args
    ? spawnSync(options.copyCommand ?? (process.platform === "darwin" ? "/bin/cp" : "cp"), args, {
        stdio: "ignore",
      })
    : null;
  if (!copied || copied.error || copied.status !== 0) {
    // A failed command may have left a partial tree.
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }
  assertContainedSymlinks(target, "copied");
  options.onCopied?.(copied && !copied.error && copied.status === 0 ? "command" : "fallback");
  return { node_modules: target, source_bin: path.join(source, ".bin") };
}
