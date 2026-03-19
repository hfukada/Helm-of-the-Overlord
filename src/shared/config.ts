// Configuration for Hoto daemon
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  workspaceDir: string;
  daemonPort: number;
  daemonHost: string;
  defaultModel: string;
  pidFile: string;
  dbPath: string;
}

function loadConfig(): Config {
  const workspaceDir =
    process.env.HOTO_WORKSPACE ?? join(homedir(), ".hoto-workspace");
  const daemonPort = parseInt(process.env.HOTO_PORT ?? "7777", 10);
  const daemonHost = process.env.HOTO_HOST ?? "127.0.0.1";
  const defaultModel = process.env.HOTO_MODEL ?? "claude-sonnet-4-6";

  return {
    workspaceDir,
    daemonPort,
    daemonHost,
    defaultModel,
    pidFile: join(workspaceDir, ".hoto.pid"),
    dbPath: join(workspaceDir, "hoto.db"),
  };
}

export const config = loadConfig();

export function daemonUrl(path: string): string {
  return `http://${config.daemonHost}:${config.daemonPort}${path}`;
}
