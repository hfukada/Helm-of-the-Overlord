import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";
import { fixDatesAll } from "../dates";

const childTasks = new Hono();

// List child tasks for a parent task
childTasks.get("/:taskId/children", (c) => {
  const taskId = c.req.param("taskId");
  const db = getDb();

  const children = db.query(
    `SELECT ct.*, r.name as repo_name, r.language, r.framework
     FROM child_tasks ct
     JOIN repos r ON r.id = ct.repo_id
     WHERE ct.parent_task_id = ?
     ORDER BY r.name`
  ).all(taskId) as Array<Record<string, unknown>>;

  return c.json(fixDatesAll(children, "created_at", "updated_at"));
});

// Cancel a child task
childTasks.post("/:taskId/children/:childId/cancel", async (c) => {
  const childId = c.req.param("childId");
  const db = getDb();

  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE child_tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('committed', 'cancelled')",
    [now, childId]
  );

  if (result.changes === 0) {
    return c.json({ error: "Child task not found or already in terminal state" }, 400);
  }

  logger.info("Child task cancelled", { childId });

  // Check if parent should be updated
  const { checkParentCompletion } = await import("../../orchestrator/child-task-runner");
  const row = db.query("SELECT parent_task_id FROM child_tasks WHERE id = ?").get(childId) as { parent_task_id: string } | null;
  if (row) checkParentCompletion(row.parent_task_id);

  return c.json({ id: childId, status: "cancelled" });
});

// Retry a failed child task
childTasks.post("/:taskId/children/:childId/retry", async (c) => {
  const childId = c.req.param("childId");
  const db = getDb();

  const child = db.query(
    "SELECT * FROM child_tasks WHERE id = ? AND status IN ('error', 'cancelled')"
  ).get(childId) as Record<string, unknown> | null;

  if (!child) {
    return c.json({ error: "Child task not found or not in retryable state" }, 400);
  }

  const now = new Date().toISOString();
  db.run("UPDATE child_tasks SET status = 'pending', updated_at = ? WHERE id = ?", [now, childId]);

  // Re-run the child task
  const { runChildTask } = await import("../../orchestrator/child-task-runner");
  runChildTask(childId).catch((err) => {
    logger.error("Child task retry failed", { childId, error: String(err) });
    db.run("UPDATE child_tasks SET status = 'error', updated_at = datetime('now') WHERE id = ?", [childId]);
  });

  return c.json({ id: childId, status: "pending" });
});

export { childTasks };
