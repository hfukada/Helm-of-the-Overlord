import { Hono } from "hono";
import { getDb } from "../../knowledge/db";

const comments = new Hono();

// List comments for a task
comments.get("/:taskId/comments", (c) => {
  const taskId = c.req.param("taskId");
  const db = getDb();
  const rows = db
    .query(
      "SELECT * FROM diff_comments WHERE task_id = ? ORDER BY file_path, line_number"
    )
    .all(taskId);
  return c.json(rows);
});

// Create a comment
comments.post("/:taskId/comments", async (c) => {
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{
    file_path: string;
    line_number?: number;
    side?: string;
    body: string;
  }>();

  if (!body.file_path || !body.body) {
    return c.json({ error: "file_path and body are required" }, 400);
  }

  const db = getDb();

  // Verify task exists
  const task = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const result = db.run(
    `INSERT INTO diff_comments (task_id, file_path, line_number, side, body)
     VALUES (?, ?, ?, ?, ?)`,
    [
      taskId,
      body.file_path,
      body.line_number ?? null,
      body.side ?? "right",
      body.body,
    ]
  );

  return c.json(
    {
      id: Number(result.lastInsertRowid),
      task_id: taskId,
      file_path: body.file_path,
      line_number: body.line_number ?? null,
      side: body.side ?? "right",
      body: body.body,
      resolved: 0,
    },
    201
  );
});

// Update a comment
comments.patch("/comments/:commentId", async (c) => {
  const commentId = c.req.param("commentId");
  const body = await c.req.json<{
    body?: string;
    resolved?: boolean;
  }>();

  const db = getDb();
  const existing = db
    .query("SELECT * FROM diff_comments WHERE id = ?")
    .get(commentId);
  if (!existing) {
    return c.json({ error: "Comment not found" }, 404);
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.body !== undefined) {
    sets.push("body = ?");
    params.push(body.body);
  }
  if (body.resolved !== undefined) {
    sets.push("resolved = ?");
    params.push(body.resolved ? 1 : 0);
  }

  if (sets.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  params.push(commentId);
  db.run(`UPDATE diff_comments SET ${sets.join(", ")} WHERE id = ?`, params);

  const updated = db
    .query("SELECT * FROM diff_comments WHERE id = ?")
    .get(commentId);
  return c.json(updated);
});

// Delete a comment
comments.delete("/comments/:commentId", (c) => {
  const commentId = c.req.param("commentId");
  const db = getDb();
  const result = db.run("DELETE FROM diff_comments WHERE id = ?", [commentId]);
  if (result.changes === 0) {
    return c.json({ error: "Comment not found" }, 404);
  }
  return c.json({ deleted: true });
});

export { comments };
