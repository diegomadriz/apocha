// @ts-check
// Private bounded bridge: debug config is one pretty JSON document, not JSONL.
// The child shares this helper's process group so runJsonlProcess kills both.
import { spawn } from "node:child_process";

const [mode, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
let output = "";
let size = 0;
let failed = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  size += Buffer.byteLength(chunk, "utf8");
  if (size > 1024 * 1024) {
    failed = true;
    child.kill("SIGKILL");
  } else output += chunk.toString("utf8");
});
child.on("error", () => {
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (failed || code !== 0) {
    process.exitCode = 1;
    return;
  }
  try {
    const value = mode === "version" ? /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] : JSON.parse(output);
    if (!value) throw new Error("invalid");
    process.stdout.write(JSON.stringify({ value }) + "\n");
  } catch {
    process.exitCode = 1;
  }
});
