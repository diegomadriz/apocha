#!/usr/bin/env node
// @ts-check
import { run } from "../src/cli/main.mjs";

await run(process.argv.slice(2));
