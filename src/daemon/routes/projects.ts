import { Hono } from "hono";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { fixDates, fixDatesAll } from "../dates";

const projects = new Hono();

// GET /projects
projects.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC").all() as Record<string, unknown>[];
  return c.json(fixDatesAll(rows, "created_at", "updated_at"));
});

// GET /projects/:id
projects.get("/:id", (c) => {
  const db = getDb();
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(c.req.param("id")) as Record<string, unknown> | null;
  if (!project) return c.json({ error: "Not found" }, 404);
  const tasks = db
    .query("SELECT id, title, status, created_at FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
    .all(c.req.param("id")) as Record<string, unknown>[];
  fixDates(project, "created_at", "updated_at");
  return c.json({ ...project, tasks: fixDatesAll(tasks, "created_at") });
});

// POST /projects
projects.post("/", async (c) => {
  const body = await c.req.json();
  if (!body.title || !body.description) {
    return c.json({ error: "title and description are required" }, 400);
  }
  const db = getDb();
  const id = ulid();
  db.run(
    "INSERT INTO projects (id, title, description, architecture_notes) VALUES (?, ?, ?, ?)",
    [id, body.title, body.description, body.architecture_notes ?? null]
  );
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
  return c.json(fixDates(row, "created_at", "updated_at"), 201);
});

// PATCH /projects/:id
projects.patch("/:id", async (c) => {
  const db = getDb();
  const existing = db.query("SELECT id FROM projects WHERE id = ?").get(c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json();
  const ALLOWED_PATCH_FIELDS = new Set([
    "title", "description", "status",
    "architecture_notes", "carry_over_notes",
  ]);
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => ALLOWED_PATCH_FIELDS.has(k))
  );
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields" }, 400);
  }

  const setClauses = [...Object.keys(updates).map((k) => `${k} = ?`), "updated_at = datetime('now')"];
  const values = [...Object.values(updates), c.req.param("id")];
  db.run(`UPDATE projects SET ${setClauses.join(", ")} WHERE id = ?`, values);

  const row = db.query("SELECT * FROM projects WHERE id = ?").get(c.req.param("id")) as Record<string, unknown>;
  return c.json(fixDates(row, "created_at", "updated_at"));
});

export default projects;
