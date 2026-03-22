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
  chromaUrl: string;
  matrixHomeserverUrl: string | null;
  matrixBotUser: string;
  matrixBotPassword: string | null;
  matrixBotToken: string | null;
  giteaUrl: string | null;
  giteaAdminToken: string | null;
  giteaBotUser: string;
  giteaBotPassword: string;
  giteaOrg: string;
  giteaPollIntervalMs: number;
}

function loadConfig(): Config {
  const workspaceDir =
    process.env.HOTO_WORKSPACE ?? join(homedir(), ".hoto-workspace");
  const daemonPort = parseInt(process.env.HOTO_PORT ?? "7777", 10);
  const daemonHost = process.env.HOTO_HOST ?? "127.0.0.1";
  const defaultModel = process.env.HOTO_MODEL ?? "claude-sonnet-4-6";

  const chromaUrl = process.env.CHROMA_URL ?? "http://127.0.0.1:8000";
  const matrixHomeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? null;
  const matrixBotUser = process.env.MATRIX_BOT_USER ?? "@hoto:localhost";
  const matrixBotPassword = process.env.MATRIX_BOT_PASSWORD ?? null;
  const matrixBotToken = process.env.MATRIX_BOT_TOKEN ?? null;

  const giteaUrl = process.env.GITEA_URL ?? null;
  const giteaAdminToken = process.env.GITEA_ADMIN_TOKEN ?? null;
  const giteaBotUser = process.env.GITEA_BOT_USER ?? "hoto-bot";
  const giteaBotPassword = process.env.GITEA_BOT_PASSWORD ?? "hoto-bot-default";
  const giteaOrg = process.env.GITEA_ORG ?? "hoto";
  const giteaPollIntervalMs = parseInt(process.env.GITEA_POLL_INTERVAL_MS ?? "15000", 10);

  return {
    workspaceDir,
    daemonPort,
    daemonHost,
    defaultModel,
    pidFile: join(workspaceDir, ".hoto.pid"),
    dbPath: join(workspaceDir, "hoto.db"),
    chromaUrl,
    matrixHomeserverUrl,
    matrixBotUser,
    matrixBotPassword,
    matrixBotToken,
    giteaUrl,
    giteaAdminToken,
    giteaBotUser,
    giteaBotPassword,
    giteaOrg,
    giteaPollIntervalMs,
  };
}

export const config = loadConfig();

export function daemonUrl(path: string): string {
  return `http://${config.daemonHost}:${config.daemonPort}${path}`;
}
