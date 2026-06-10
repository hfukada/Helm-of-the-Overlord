// Configuration for Hoto daemon
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

export interface Config {
  workspaceDir: string;
  workspaceHostDir: string;
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
  discordBotToken: string | null;
  discordGuildId: string | null;
  giteaUrl: string | null;
  giteaAdminToken: string | null;
  giteaBotUser: string;
  giteaBotPassword: string;
  giteaOrg: string;
  giteaPollIntervalMs: number;
  sandboxClaude: boolean;
  mcpHttpPort: number;
  autoResumeOnStartup: boolean;
  provider: 'claude' | 'ollama' | 'cursor';
  ollamaHost: string;
  ollamaModel: string;
  cursorApiKey: string | null;
  cursorModel: string;
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function loadConfig(): Config {
  const workspaceDir = expandHome(
    process.env.HOTO_WORKSPACE ?? join(homedir(), ".hoto-workspace")
  );
  // Host-side path for the workspace. When hoto runs in Docker, this may
  // differ from workspaceDir -- workspaceDir is the in-container mount point
  // (e.g. /data) and workspaceHostDir is the host directory being bind-mounted
  // (e.g. /home/user/hoto/data). Sandbox/CI containers are spawned via the
  // host's Docker socket, so their bind mounts must use host paths.
  // Defaults to workspaceDir when not set (bare-metal case).
  const workspaceHostDir = process.env.HOTO_WORKSPACE_HOST
    ? expandHome(process.env.HOTO_WORKSPACE_HOST)
    : workspaceDir;
  const daemonPort = parseInt(process.env.HOTO_PORT ?? "7777", 10);
  const daemonHost = process.env.HOTO_HOST ?? "127.0.0.1";
  const defaultModel = process.env.HOTO_MODEL ?? "claude-sonnet-4-6";

  const chromaUrl = process.env.CHROMA_URL ?? "http://127.0.0.1:8033";
  const matrixHomeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? null;
  const matrixBotUser = process.env.MATRIX_BOT_USER ?? "@hoto:localhost";
  const matrixBotPassword = process.env.MATRIX_BOT_PASSWORD ?? null;
  const matrixBotToken = process.env.MATRIX_BOT_TOKEN ?? null;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? null;
  const discordGuildId = process.env.DISCORD_GUILD_ID ?? null;

  const giteaUrl = process.env.GITEA_URL ?? null;
  const giteaAdminToken = process.env.GITEA_ADMIN_TOKEN ?? null;
  const giteaBotUser = process.env.GITEA_BOT_USER ?? "hoto-bot";
  const giteaBotPassword = process.env.GITEA_BOT_PASSWORD ?? "hoto-bot-default";
  const giteaOrg = process.env.GITEA_ORG ?? "hoto";
  const giteaPollIntervalMs = parseInt(process.env.GITEA_POLL_INTERVAL_MS ?? "15000", 10);
  const sandboxClaude = process.env.HOTO_SANDBOX_CLAUDE === "true" || process.env.HOTO_SANDBOX_CLAUDE === "1";
  const mcpHttpPort = parseInt(process.env.HOTO_MCP_HTTP_PORT ?? "7778", 10);
  const autoResumeOnStartup = process.env.HOTO_AUTO_RESUME !== "false" && process.env.HOTO_AUTO_RESUME !== "0";

  const providerRaw = process.env.HOTO_PROVIDER ?? 'claude';
  if (providerRaw !== 'claude' && providerRaw !== 'ollama' && providerRaw !== 'cursor') {
    logger.error({ provider: providerRaw }, 'Unknown provider. Must be one of: claude, ollama, cursor');
    throw new Error(`Unknown provider: ${providerRaw}. Must be one of: claude, ollama, cursor`);
  }
  const provider = providerRaw as 'claude' | 'ollama' | 'cursor';
  const ollamaHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3.2';
  const cursorApiKey = process.env.CURSOR_API_KEY ?? null;
  const cursorModel = process.env.CURSOR_MODEL ?? 'cursor-small';

  return {
    workspaceDir,
    workspaceHostDir,
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
    discordBotToken,
    discordGuildId,
    giteaUrl,
    giteaAdminToken,
    giteaBotUser,
    giteaBotPassword,
    giteaOrg,
    giteaPollIntervalMs,
    sandboxClaude,
    mcpHttpPort,
    autoResumeOnStartup,
    provider,
    ollamaHost,
    ollamaModel,
    cursorApiKey,
    cursorModel,
  };
}

export const config = loadConfig();

export function daemonUrl(path: string): string {
  return `http://${config.daemonHost}:${config.daemonPort}${path}`;
}
