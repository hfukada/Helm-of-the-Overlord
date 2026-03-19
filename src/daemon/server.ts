import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { tasks } from "./routes/tasks";
import { agents } from "./routes/agents";
import { repos } from "./routes/repos";
import { tokens } from "./routes/tokens";
import { knowledge } from "./routes/knowledge";
import { comments } from "./routes/comments";
import { commits } from "./routes/commits";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureWorkspace } from "../workspace/manager";
import { getDb } from "../knowledge/db";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

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
app.route("/tokens", tokens);
app.route("/knowledge", knowledge);

// Serve web UI static files
// import.meta.dir = <project>/src/daemon
const webDistDir = join(import.meta.dir, "..", "web", "dist");

app.use(
  "/app/*",
  serveStatic({
    root: webDistDir,
    rewriteRequestPath: (path) => path.replace(/^\/app/, ""),
  })
);

// SPA fallback: serve index.html for all /app/* routes that don't match a file
app.get("/app/*", async (c) => {
  try {
    const indexPath = join(webDistDir, "index.html");
    const file = Bun.file(indexPath);
    if (await file.exists()) {
      return c.html(await file.text());
    }
  } catch {}
  return c.json(
    { error: "Web UI not built. Run: cd src/web && bun run build" },
    404
  );
});

export async function startDaemon(): Promise<void> {
  await ensureWorkspace();
  getDb(); // Initialize DB + run migrations

  const server = Bun.serve({
    port: config.daemonPort,
    hostname: config.daemonHost,
    fetch: app.fetch,
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
    server.stop();
    try {
      await unlink(config.pidFile);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
