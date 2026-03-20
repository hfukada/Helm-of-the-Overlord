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
import { secrets } from "./routes/secrets";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureWorkspace } from "../workspace/manager";
import { getDb } from "../knowledge/db";
import { writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

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

async function ensureWebBuild(): Promise<void> {
  const indexPath = join(webDistDir, "index.html");
  try {
    await access(indexPath);
  } catch {
    logger.info("Web UI not built, building...");
    const webDir = join(import.meta.dir, "..", "web");
    await $`bun install --frozen-lockfile`.cwd(webDir).quiet().nothrow();
    const result = await $`bun run build`.cwd(webDir).quiet().nothrow();
    if (result.exitCode !== 0) {
      logger.warn("Web UI build failed, UI will be unavailable", {
        stderr: result.stderr.toString().slice(0, 500),
      });
    } else {
      logger.info("Web UI built successfully");
    }
  }
}

export async function startDaemon(): Promise<void> {
  await ensureWorkspace();
  getDb(); // Initialize DB + run migrations
  await ensureWebBuild();

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
