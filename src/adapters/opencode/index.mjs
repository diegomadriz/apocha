// @ts-check
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { sourceSecretFiles } from "../../checks/runner.mjs";
import { roleProvider } from "../../config/runtime.mjs";
import { toolDefinitions } from "../../tools/definitions.mjs";
import { HarnessError } from "../../util/errors.mjs";
import { git } from "../../util/git.mjs";
import { classifyProviderMessage, compareVersions, runJsonlProcess } from "../process.mjs";

const CAPTURE = fileURLToPath(new URL("./capture.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../mcp-server-main.mjs", import.meta.url));
const VERSION = "1.19.3";

/** @param {string} code @param {string} message */
function configError(code, message) {
  return new HarnessError("config", code, message);
}

/** Paths are checked for existence only; machine policy is never read or bypassed.
 * @param {string} [platform] @param {string} [username] @param {string} [programData]
 */
export function machineConfigPaths(
  platform = process.platform,
  username = os.userInfo().username,
  programData = process.env.ProgramData || "C:\\ProgramData",
) {
  if (platform === "darwin")
    return [
      "/Library/Application Support/opencode",
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      path.join("/Library/Managed Preferences", username, "ai.opencode.managed.plist"),
    ];
  if (platform === "win32") return [path.win32.join(programData, "opencode")];
  return ["/etc/opencode"];
}

/** @param {string[]} [paths] */
export function assertNoMachineConfig(paths = machineConfigPaths()) {
  for (const file of paths) {
    try {
      lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw configError("opencode_machine_config", "Cannot verify absence of machine OpenCode configuration");
    }
    throw configError(
      "opencode_machine_config",
      "Machine OpenCode configuration is present; refusing experimental runtime",
    );
  }
}

/** @param {string} name */
export function secretLookingPath(name) {
  const base = path.posix.basename(name).toLowerCase();
  if (/^\.env\.(?:example|sample|template)$/.test(base)) return false;
  return /^(?:\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$/.test(base) || /\.(?:pem|key)$/.test(base);
}

/** @param {string} sessionFile */
function assertPublicSource(sessionFile) {
  try {
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (typeof session.repository_root !== "string") throw new Error("missing root");
    if (sourceSecretFiles(session.repository_root).length) throw new Error("secret");
    const tracked = String(git(session.repository_root, ["ls-files", "-z"]).stdout).split("\0");
    if (tracked.some(secretLookingPath)) throw new Error("secret");
  } catch {
    throw configError(
      "opencode_source_privacy",
      "Cannot establish secret-free source filenames; use public/synthetic inputs only",
    );
  }
}

/** @param {string} root */
function cleanupPrivateDirectory(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    throw new HarnessError("infra", "opencode_cleanup", "OpenCode private runtime cleanup failed");
  }
}

/** @param {string} root */
function isolatedEnvironment(root) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of [
    "HOME",
    "OPENCODE_TEST_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
  ]) {
    env[key] = path.join(root, key.toLowerCase());
    mkdirSync(env[key], { mode: 0o700 });
  }
  return {
    ...env,
    OPENCODE_CONFIG: path.join(root, "config.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

/** @param {import("../contract.mjs").Invocation} invocation */
export function opencodeConfig(invocation) {
  const permission = Object.fromEntries([
    ["*", "deny"],
    ...toolDefinitions(invocation.role).map((t) => ["apocha_" + t.name, "allow"]),
  ]);
  return {
    enabled_providers: ["opencode"],
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    lsp: false,
    formatter: false,
    plugin: [],
    instructions: [],
    default_agent: "apocha",
    permission,
    agent: { apocha: { mode: "primary", prompt: invocation.systemPrompt, permission } },
    mcp: {
      apocha: {
        type: "local",
        command: [process.execPath, SERVER],
        environment: { APOCHA_SESSION: path.resolve(invocation.sessionFile) },
        enabled: true,
        timeout: Math.max(1, invocation.timeoutMs),
      },
    },
  };
}

/** @param {any} value */
function emptyPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0
  );
}

/** Reject unexpected fields except CLI metadata and three exact empty V1.19.3 defaults.
 * @param {any} resolved @param {any} expected
 */
export function validateOpencodeConfig(resolved, expected) {
  const clean = { ...resolved };
  delete clean.$schema;
  delete clean.username;
  for (const key of ["mode", "command"]) {
    if (!Object.hasOwn(expected, key) && emptyPlainObject(clean[key])) delete clean[key];
  }
  if (
    !Object.hasOwn(expected.agent?.apocha ?? {}, "options") &&
    emptyPlainObject(clean.agent?.apocha?.options)
  ) {
    clean.agent = { ...clean.agent, apocha: { ...clean.agent.apocha } };
    delete clean.agent.apocha.options;
  }
  if (!isDeepStrictEqual(clean, expected))
    throw configError(
      "opencode_config_contamination",
      "OpenCode resolved configuration does not match the private policy",
    );
}

/** @returns {{ allowed: Set<string>, seen: Set<string>, usage: Record<string, number | null>, known: number, final_message?: string, providerError?: string }} */
export function opencodeState() {
  return {
    allowed: new Set(),
    seen: new Set(),
    usage: {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_input_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    },
    known: 0,
  };
}

/** @param {any} event @param {ReturnType<typeof opencodeState>} state */
export function inspectOpencodeEvent(event, state) {
  const part = event?.part ?? event?.properties?.part;
  const toolEvent =
    /tool/i.test(String(event?.type ?? "")) ||
    /tool/i.test(String(part?.type ?? "")) ||
    part?.tool !== undefined ||
    event?.tool !== undefined;
  if (toolEvent) {
    const tool = part?.tool ?? event?.tool;
    if (typeof tool !== "string" || !state.allowed.has(tool)) {
      throw new HarnessError(
        "policy_violation",
        "opencode_foreign_tool",
        "OpenCode reported a tool outside the exact harness allowlist",
      );
    }
    state.known++;
  }
  if (event?.type === "error") {
    state.known++;
    state.providerError = String(
      event.error?.data?.message ?? event.error?.error?.data?.message ?? "provider error",
    ).slice(0, 8000);
  }
  if (event?.type === "text" && typeof part?.text === "string") {
    state.known++;
    state.final_message = part.text.slice(0, 2000);
  }
  if (event?.type === "step_start") state.known++;
  if (event?.type === "step_finish") {
    state.known++;
    if (typeof part?.id !== "string")
      throw new HarnessError("tool_protocol", "opencode_step_id", "OpenCode step lacks an identity");
    if (state.seen.has(part.id)) return;
    state.seen.add(part.id);
    const values = {
      input_tokens: part.tokens?.input,
      output_tokens: part.tokens?.output,
      reasoning_tokens: part.tokens?.reasoning,
      cached_input_tokens: part.tokens?.cache?.read,
      cache_write_tokens: part.tokens?.cache?.write,
      cost_usd: part.cost,
    };
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        state.usage[key] = (state.usage[key] ?? 0) + value;
    }
  }
}

/** @param {import("../../config/runtime.mjs").AdapterSettings} [settings] */
export function createOpencodeAdapter(settings = {}) {
  const command = settings.command ?? "opencode";
  /** @param {import("../contract.mjs").Invocation | undefined} invocation */
  async function execute(invocation) {
    const started = Date.now();
    const budget = invocation?.timeoutMs ?? 20000;
    const remaining = () => {
      const ms = budget - (Date.now() - started);
      if (ms <= 0) throw new HarnessError("infra", "timeout", "OpenCode exceeded total invocation budget");
      return ms;
    };
    assertNoMachineConfig();
    if (invocation) {
      if (!/^opencode\/[^/\s]+$/.test(invocation.model ?? ""))
        throw configError(
          "opencode_unsupported_auth",
          "Only unauthenticated opencode/provider models are supported; other providers require unsupported authentication",
        );
      const vendor = roleProvider(
        { adapter: "opencode", model: invocation.model, provider: invocation.provider },
        settings,
      );
      if (vendor === "unknown" || !vendor.trim())
        throw configError(
          "opencode_unknown_vendor",
          "OpenCode gateway requires an explicit actual model vendor",
        );
      assertPublicSource(invocation.sessionFile);
    }
    const root = mkdtempSync(path.join(os.tmpdir(), "apocha-opencode-"));
    try {
      chmodSync(root, 0o700);
      const env = isolatedEnvironment(root);
      const cwd = path.join(root, "cwd");
      mkdirSync(cwd, { mode: 0o700 });
      const config = invocation ? opencodeConfig(invocation) : {};
      writeFileSync(env.OPENCODE_CONFIG, JSON.stringify(config), { mode: 0o600 });
      /** @param {string} mode @param {string[]} args */
      const capture = async (mode, args) => {
        let value;
        const exit = await runJsonlProcess({
          command: process.execPath,
          args: [CAPTURE, mode, command, ...args],
          cwd,
          env,
          input: "",
          timeoutMs: remaining(),
          signal: invocation?.signal,
          onEvent: (event) => {
            value = event.value;
          },
        });
        if (exit.code !== 0 || value === undefined)
          throw new HarnessError("infra", "opencode_preflight", "OpenCode version/config preflight failed");
        return value;
      };
      const version = await capture("version", ["--version"]);
      if (version !== VERSION || compareVersions(version, settings.min_version ?? VERSION) < 0)
        throw new HarnessError(
          "config",
          "opencode_version",
          "Experimental OpenCode requires exactly 1.19.3 until retested",
          { details: { version } },
        );
      if (!invocation) return { version };
      validateOpencodeConfig(await capture("config", ["debug", "config"]), config);
      // Also verify the private input after debug: a falsified resolved document
      // cannot conceal changes to the actual config on disk.
      validateOpencodeConfig(JSON.parse(readFileSync(env.OPENCODE_CONFIG, "utf8")), config);
      const state = opencodeState();
      state.allowed = new Set(toolDefinitions(invocation.role).map((t) => "apocha_" + t.name));
      const args = ["--pure", "run", "--format", "json", "--agent", "apocha", "-m", invocation.model];
      const variant = invocation.variant ?? invocation.effort;
      if (variant) args.push("--variant", variant);
      const exit = await runJsonlProcess({
        command,
        args,
        cwd,
        env,
        input: invocation.taskPrompt,
        timeoutMs: remaining(),
        signal: invocation.signal,
        onEvent: (event) => inspectOpencodeEvent(event, state),
      });
      const runtime = {
        adapter: "opencode",
        adapter_version: version,
        model: invocation.model,
        provider: roleProvider(
          { adapter: "opencode", model: invocation.model, provider: invocation.provider },
          settings,
        ),
      };
      if (state.providerError) {
        const { errorClass, retryAfter } = classifyProviderMessage(state.providerError);
        const safeRetry =
          retryAfter &&
          /^[\w\s:,+./-]{1,100}$/.test(retryAfter) &&
          !/token|secret|key|bearer/i.test(retryAfter)
            ? retryAfter
            : null;
        throw new HarnessError(
          errorClass,
          "opencode_provider_error",
          "OpenCode provider rejected the request",
          { retryAfter: safeRetry, details: { runtime } },
        );
      }
      if (exit.code !== 0)
        throw new HarnessError("infra", "opencode_exit", "OpenCode process failed", { details: { runtime } });
      if (!state.known)
        throw new HarnessError(
          "tool_protocol",
          "opencode_unknown_stream",
          "OpenCode returned no recognized runtime events",
        );
      return {
        runtime,
        usage: state.usage,
        ...(state.final_message !== undefined ? { final_message: state.final_message } : {}),
      };
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("infra", "opencode_failure", "OpenCode private runtime failed");
    } finally {
      cleanupPrivateDirectory(root);
    }
  }
  return {
    name: "opencode",
    async probe() {
      try {
        const result = await execute(undefined);
        return {
          adapter: "opencode",
          command,
          version: result.version ?? null,
          ok: true,
          problems: [
            "Experimental: public/synthetic data only; strict built-in denial may cause provider HTTP403. Synthetic role probes required.",
          ],
        };
      } catch (error) {
        return {
          adapter: "opencode",
          command,
          version:
            error instanceof HarnessError && typeof error.details.version === "string"
              ? error.details.version
              : null,
          ok: false,
          problems: [error instanceof HarnessError ? error.message : "OpenCode probe failed"],
        };
      }
    },
    /** @param {import("../contract.mjs").Invocation} invocation */
    async run(invocation) {
      const result = await execute(invocation);
      if (!("runtime" in result)) throw new HarnessError("infra", "opencode_failure", "OpenCode run failed");
      return result;
    },
  };
}
