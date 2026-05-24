import { Hono } from "hono";
import { cors } from "hono/cors";
import { tasks } from "./routes/tasks";
import { agents } from "./routes/agents";
import { repos } from "./routes/repos";
import { tokens } from "./routes/tokens";
import { knowledge } from "./routes/knowledge";
import { comments } from "./routes/comments";
import { commits } from "./routes/commits";
import { secrets } from "./routes/secrets";
import { relationships } from "./routes/relationships";
import { childTasks } from "./routes/child-tasks";
import { version } from "./routes/version";
import projects from "./routes/projects";
import { metrics } from "./routes/metrics";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureWorkspace } from "../workspace/manager";
import { getDb } from "../knowledge/db";
import { initTokenCounters } from "../shared/token-counters";
import { MessagingManager, setMessagingManager } from "../messaging/manager";
import { initGiteaClient } from "../gitea/client";
import { restartPollersForReviewTasks } from "../gitea/review-poller";
import { writeFile, unlink } from "node:fs/promises";

const app = new Hono();

app.use("/*", cors());

app.get("/health", (c) => c.json({ status: "ok", pid: process.pid }));

app.route("/version", version);
app.route("/tasks", tasks);
app.route("/tasks", agents); // /tasks/:id/agents
app.route("/tasks", childTasks); // /tasks/:id/children
app.route("/tasks", comments); // /tasks/:id/comments
app.route("/tasks", commits); // /tasks/:id/accept, /tasks/:id/commit
// Top-level comment routes (PATCH/DELETE use /comments/:id)
app.route("/", comments);
app.route("/repos", repos);
app.route("/repos", secrets); // /repos/:name/secrets
app.route("/repos", relationships); // /repos/:name/relationships + /repos/relationships
app.route("/tokens", tokens);
app.route("/knowledge", knowledge);
app.route("/projects", projects);
app.route("/metrics", metrics);

export async function startDaemon(): Promise<void> {
  await ensureWorkspace();
  const db = getDb(); // Initialize DB + run migrations
  await initTokenCounters(db);

  const server = Bun.serve({
    port: config.daemonPort,
    hostname: config.daemonHost,
    fetch: app.fetch,
    idleTimeout: 120,
  });

  // Start MCP HTTP server if sandbox mode is enabled
  let mcpHttpStop: (() => void) | null = null;
  if (config.sandboxClaude) {
    const { startMcpHttpServer } = await import("../mcp/http-server");
    const mcpHttp = startMcpHttpServer();
    mcpHttpStop = mcpHttp.stop;
  }

  // Verify ChromaDB is available (required for vector search)
  const { isChromaAvailable } = await import("../knowledge/chromadb");
  const chromaReady = await isChromaAvailable();
  if (!chromaReady) {
    logger.error("ChromaDB not available, exiting", { url: config.chromaUrl });
    process.exit(1);
  }
  logger.info("ChromaDB ready", { url: config.chromaUrl });

  // Initialize Gitea if configured
  // Auth failures in initGiteaClient call process.exit(1) directly.
  // We only catch connectivity issues (e.g. Gitea not reachable yet).
  if (config.giteaUrl) {
    try {
      await initGiteaClient();
      restartPollersForReviewTasks();
      logger.info("Gitea integration initialized");
    } catch (err) {
      logger.error("Gitea initialization failed", { error: String(err) });
      process.exit(1);
    }
  }

  // Initialize messaging
  const manager = new MessagingManager();
  setMessagingManager(manager);

  const activeConnectors: string[] = [];

  if (config.matrixHomeserverUrl) {
    try {
      const { MatrixProvider } = await import("../messaging/matrix/client");
      const matrixProvider = new MatrixProvider();
      await matrixProvider.connect();
      manager.registerProvider(matrixProvider);
      const mainChannelId = matrixProvider.getMainChannelId();
      if (mainChannelId) {
        manager.setMainChannel("matrix", mainChannelId);
      }
      activeConnectors.push("matrix");
      logger.info("Matrix messaging initialized", { mainChannel: mainChannelId });
    } catch (err) {
      logger.warn("Matrix messaging failed to initialize, continuing without it", { error: String(err) });
    }
  }

  if (config.discordBotToken && config.discordGuildId) {
    try {
      const { DiscordProvider } = await import("../messaging/discord/client");
      const discordProvider = new DiscordProvider(config.discordBotToken, config.discordGuildId);
      await discordProvider.connect();
      manager.registerProvider(discordProvider);
      const mainChannelId = discordProvider.getMainChannelId();
      if (mainChannelId) {
        manager.setMainChannel("discord", mainChannelId);
      }
      activeConnectors.push("discord");
      logger.info("Discord messaging initialized", { mainChannel: mainChannelId });
    } catch (err) {
      logger.warn("Discord messaging failed to initialize, continuing without it", { error: String(err) });
    }
  }

  if (activeConnectors.length > 0) {
    logger.info("Messaging connectors active", { connectors: activeConnectors });
  }

  // Resume interrupted tasks from previous daemon session
  const { resumeInterruptedTasks } = await import("../orchestrator/resume-on-startup");
  resumeInterruptedTasks().catch((err) => {
    logger.error("Failed to resume interrupted tasks", { error: String(err) });
  });

  // Write PID file
  await writeFile(config.pidFile, String(process.pid));

  logger.info("Daemon started", {
    port: config.daemonPort,
    host: config.daemonHost,
    pid: process.pid,
  });

  // Handle shutdown
  const shutdown = async () => {
    logger.info("Daemon shutting down");
    // Disconnect messaging
    const { getMessagingManager } = await import("../messaging/manager");
    const manager = getMessagingManager();
    if (manager) {
      try { await manager.stop(); } catch {}
    }
    if (mcpHttpStop) mcpHttpStop();
    server.stop();
    try {
      await unlink(config.pidFile);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
