#!/usr/bin/env bun

import { join } from "node:path";
import { loadDotenv } from "./shared/dotenv";
import { expandHome } from "./shared/config";

export {};

const args = process.argv.slice(2);

const workspaceBase = expandHome(
  process.env.HOTO_WORKSPACE ?? "~/.hoto-workspace"
);
const dotenvPath = process.env.HOTO_DOTENV ?? join(workspaceBase, ".env");
await loadDotenv(dotenvPath);

if (args[0] === "daemon" && args[1] === "__serve") {
  const { startDaemon } = await import("./daemon/server");
  await startDaemon();
} else {
  const { runCli } = await import("./cli/index");
  await runCli(args);
}
