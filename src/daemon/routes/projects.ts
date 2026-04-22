import { Hono } from "hono";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { fixDates, fixDatesAll } from "../dates";
import { logger } from "../../shared/logger";

const projects = new Hono();

const ALLOWED_PATCH_FIELDS = ["title", "description", "status", "architecture_notes", "carry_over_notes"] as const;

function parseProjectRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    milestones: typeof row.milestones === "string" ? JSON.parse(row.milestones) : (row.milestones ?? []),
    repo_names: typeof row.repo_names === "string" ? JSON.parse(row.repo_names) : (row.repo_names ?? []),
  };
}

projects.get("/", (c) => {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC LIMIT 100")
    .all() as Record<string, unknown>[];
  return c.json(fixDatesAll(rows.map(parseProjectRow), "created_at", "updated_at"));
});

projects.post("/", async (c) => {
  const body = await c.req.json<Record<string, string | string[] | null>>();
  if (!body.description) return c.json({ error: "description is required" }, 400);

  const db = getDb();
  const id = ulid();
  const now = new Date().toISOString();

  const repoNames: string[] = Array.isArray(body.repo_names)
    ? body.repo_names
    : body.repo_name
    ? [body.repo_name as string]
    : [];

  db.run(
    `INSERT INTO projects (id, title, description, status, architecture_notes, milestones, current_milestone, repo_id, repo_names, source_sender_id, source_provider, created_at, updated_at)
     VALUES (?, ?, ?, 'planning', ?, '[]', 0, NULL, ?, ?, ?, ?, ?)`,
    [id, "Planning…", body.description as string, (body.architecture_notes as string | null) ?? null, JSON.stringify(repoNames), (body.source_sender_id as string | null) ?? null, (body.source_provider as string | null) ?? null, now, now]
  );

  const { createProject } = await import("../../projects/runner");
  createProject(
    body.description as string,
    repoNames,
    (body.source_sender_id as string | null) ?? null,
    (body.source_provider as string | null) ?? null,
    id,
  ).catch((err) => {
    logger.error("Background project creation failed", { projectId: id, error: String(err) });
  });

  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
  return c.json(fixDates(parseProjectRow(row), "created_at", "updated_at"), 201);
});

projects.get("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return c.json({ error: "Not found" }, 404);
  const tasks = db
    .query("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
    .all(id) as Record<string, unknown>[];
  return c.json({
    ...fixDates(parseProjectRow(row), "created_at", "updated_at"),
    tasks: fixDatesAll(tasks, "created_at", "updated_at"),
  });
});

projects.patch("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const existing = db.query("SELECT id FROM projects WHERE id = ?").get(id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Record<string, string | null>>();
  const updates: Record<string, string | null> = {};
  for (const field of ALLOWED_PATCH_FIELDS) {
    if (field in body) updates[field] = body[field];
  }
  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  const values = [...Object.values(updates), id];
  db.run(`UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?`, values);
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
  return c.json(fixDates(parseProjectRow(row), "created_at", "updated_at"));
});

projects.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const existing = db.query("SELECT id FROM projects WHERE id = ?").get(id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  db.run("DELETE FROM projects WHERE id = ?", [id]);
  return c.json({ id, deleted: true });
});

export default projects;
