import { Hono } from "hono";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { runTask, cleanupTask } from "../../orchestrator/task-runner";
import { getDiff, getDiffSummary } from "../../workspace/git";
import { worktreeDir } from "../../workspace/manager";
import { logger } from "../../shared/logger";

const tasks = new Hono();

tasks.post("/", async (c) => {
  const body = await c.req.json<{
    description: string;
    title?: string;
    repo_name?: string;
    source?: string;
  }>();

  const db = getDb();

  let repoId: number | null = null;
  if (body.repo_name) {
    const repo = db.query("SELECT id FROM repos WHERE name = ?").get(body.repo_name) as { id: number } | null;
    if (!repo) {
      return c.json({ error: `Repo '${body.repo_name}' not found` }, 404);
    }
    repoId = repo.id;
  } else {
    // Use the only repo if there's exactly one
    const repos = db.query("SELECT id FROM repos").all() as Array<{ id: number }>;
    if (repos.length === 1) {
      repoId = repos[0].id;
    } else if (repos.length === 0) {
      return c.json({ error: "No repos registered. Use 'hoto repos add' first." }, 400);
    } else {
      return c.json({ error: "Multiple repos registered. Specify one with -r." }, 400);
    }
  }

  const id = ulid();
  const title = body.title ?? body.description.slice(0, 80);

  db.run(
    `INSERT INTO tasks (id, title, description, repo_id, source)
     VALUES (?, ?, ?, ?, ?)`,
    [id, title, body.description, repoId, body.source ?? "cli"]
  );

  logger.info("Task created", { taskId: id, title });

  // Fire and forget -- run task in background
  runTask(id).catch((err) => {
    logger.error("Task execution failed", { taskId: id, error: String(err) });
    const db = getDb();
    db.run("UPDATE tasks SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [id]);
  });

  return c.json({ id, title, status: "pending" }, 201);
});

tasks.get("/", (c) => {
  const db = getDb();
  const rows = db.query(
    "SELECT id, title, status, repo_id, branch_name, source, created_at, updated_at FROM tasks ORDER BY created_at DESC"
  ).all();
  return c.json(rows);
});

tasks.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // If in review status, include diff
  let diff: string | null = null;
  let diffSummary: Array<{ file: string; insertions: number; deletions: number }> | null = null;

  if ((task.status === "review" || task.status === "accepted") && task.repo_id) {
    const repo = db.query("SELECT name FROM repos WHERE id = ?").get(task.repo_id as number) as { name: string } | null;
    if (repo) {
      try {
        const wtDir = worktreeDir(id, repo.name);
        diff = await getDiff(wtDir);
        diffSummary = await getDiffSummary(wtDir);
      } catch (err) {
        logger.warn("Failed to get diff", { taskId: id, error: String(err) });
      }
    }
  }

  // Include agent runs
  const agentRuns = db.query(
    "SELECT id, node_name, agent_type, status, token_input, token_output, cost_usd, model, started_at, finished_at, error FROM agent_runs WHERE task_id = ? ORDER BY started_at"
  ).all(id);

  // Parse blueprint_state
  let blueprintState = null;
  if (task.blueprint_state) {
    try {
      blueprintState = JSON.parse(task.blueprint_state as string);
    } catch {}
  }

  return c.json({
    ...task,
    blueprint_state: blueprintState,
    diff,
    diff_summary: diffSummary,
    agent_runs: agentRuns,
  });
});

tasks.get("/:id/ci-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .query("SELECT ci_output, ci_passed, status FROM tasks WHERE id = ?")
    .get(id) as { ci_output: string | null; ci_passed: number | null; status: string } | null;

  if (!row) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    ci_output: row.ci_output,
    ci_passed: row.ci_passed,
    status: row.status,
  });
});

tasks.get("/:id/lint-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .query("SELECT lint_output, lint_passed, status FROM tasks WHERE id = ?")
    .get(id) as { lint_output: string | null; lint_passed: number | null; status: string } | null;

  if (!row) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    lint_output: row.lint_output,
    lint_passed: row.lint_passed,
    status: row.status,
  });
});

tasks.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('committed', 'cancelled')",
    [now, id]
  );
  if (result.changes === 0) {
    return c.json({ error: "Task not found or already in terminal state" }, 400);
  }

  logger.info("Task cancelled, running cleanup", { taskId: id });

  // Run cleanup asynchronously so the response returns immediately
  cleanupTask(id).catch((err) => {
    logger.error("Cleanup failed after cancel", { taskId: id, error: String(err) });
  });

  return c.json({ id, status: "cancelled" });
});

export { tasks };
