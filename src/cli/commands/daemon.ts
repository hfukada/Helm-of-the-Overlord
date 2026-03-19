import { config } from "../../shared/config";
import { readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

export async function daemonCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "status";

  switch (subcommand) {
    case "start":
      await startDaemon();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      await daemonStatus();
      break;
    default:
      console.log(`Unknown daemon command: ${subcommand}`);
      console.log("Usage: hoto daemon start|stop|status");
  }
}

async function startDaemon(): Promise<void> {
  // Check if already running
  const pid = await readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`Daemon already running (PID ${pid})`);
    return;
  }

  // Start daemon as a background process
  const entryPoint = resolve(dirname(new URL(import.meta.url).pathname), "../../index.ts");
  const proc = Bun.spawn(
    ["bun", "run", entryPoint, "daemon", "__serve"],
    {
      stdio: ["ignore", "ignore", "ignore"],
    }
  );

  // Detach
  proc.unref();

  // Wait briefly for PID file
  await new Promise((r) => setTimeout(r, 1000));

  const newPid = await readPid();
  if (newPid) {
    console.log(`Daemon started (PID ${newPid})`);
  } else {
    console.log("Daemon started (PID file not yet written)");
  }
}

async function stopDaemon(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log("Daemon is not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid})`);
  } catch {
    console.log("Daemon process not found, cleaning up PID file");
    try {
      await unlink(config.pidFile);
    } catch {}
  }
}

async function daemonStatus(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log("Daemon is not running");
    return;
  }

  if (isProcessRunning(pid)) {
    console.log(`Daemon is running (PID ${pid})`);

    // Health check
    try {
      const res = await fetch(`http://${config.daemonHost}:${config.daemonPort}/health`);
      const data = await res.json();
      console.log(`Health: ${JSON.stringify(data)}`);
    } catch {
      console.log("Health check failed -- daemon may be starting up");
    }
  } else {
    console.log("Daemon is not running (stale PID file)");
    try {
      await unlink(config.pidFile);
    } catch {}
  }
}

async function readPid(): Promise<number | null> {
  if (!existsSync(config.pidFile)) return null;
  try {
    const content = await readFile(config.pidFile, "utf-8");
    return parseInt(content.trim(), 10);
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
