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
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureWorkspace } from "../workspace/manager";
import { getDb } from "../knowledge/db";
import { MessagingManager, setMessagingManager } from "../messaging/manager";
import { MatrixProvider } from "../messaging/matrix/client";
import { initGiteaClient } from "../gitea/client";
import { restartPollersForReviewTasks } from "../gitea/review-poller";
import { writeFile, unlink } from "node:fs/promises";

const app = new Hono();

app.use("/*", cors());

app.get("/health", (c) => c.json({ status: "ok", pid: process.pid }));

app.route("/tasks", tasks);
app.route("/tasks", agents); // /tasks/:id/agents
app.route("/tasks", comments); // /tasks/:id/comments
app.route("/tasks", commits); // /tasks/:id/accept, /tasks/:id/commit
// Top-level comment routes (PATCH/DELETE use /comments/:id)
app.route("/", comments);
app.route("/repos", repos);
app.route("/repos", secrets); // /repos/:name/secrets
app.route("/repos", relationships); // /repos/:name/relationships + /repos/relationships
app.route("/tokens", tokens);
app.route("/knowledge", knowledge);

export async function startDaemon(): Promise<void> {
  await ensureWorkspace();
  getDb(); // Initialize DB + run migrations

  const server = Bun.serve({
    port: config.daemonPort,
    hostname: config.daemonHost,
    fetch: app.fetch,
  });

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

  // Initialize messaging if configured
  if (config.matrixHomeserverUrl) {
    try {
      const provider = new MatrixProvider();
      const manager = new MessagingManager(provider);
      setMessagingManager(manager);
      await manager.start();
      logger.info("Matrix messaging initialized");
    } catch (err) {
      logger.warn("Matrix messaging failed to initialize, continuing without it", { error: String(err) });
    }
  }

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
    server.stop();
    try {
      await unlink(config.pidFile);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
