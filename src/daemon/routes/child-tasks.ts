import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";
import { fixDatesAll } from "../dates";
import { restartChildTaskPhase } from "../../orchestrator/child-task-runner";
import { NotFoundError } from "../../orchestrator/errors";

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

// Restart a child task from a specific phase
childTasks.post("/:taskId/children/:childId/restart-phase", async (c) => {
  const { taskId, childId } = c.req.param();
  const { phase } = await c.req.json();
  try {
    await restartChildTaskPhase(taskId, childId, phase);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof Error && err.message.startsWith("Unknown phase"))
      return c.json({ error: err.message }, 400);
    throw err;
  }
});

export { childTasks };
