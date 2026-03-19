#!/usr/bin/env bun

export {};

const args = process.argv.slice(2);

if (args[0] === "daemon" && args[1] === "__serve") {
  const { startDaemon } = await import("./daemon/server");
  await startDaemon();
} else {
  const { runCli } = await import("./cli/index");
  await runCli(args);
}
