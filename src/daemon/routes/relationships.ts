import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";

const relationships = new Hono();

function resolveRepoId(name: string): number | null {
  const db = getDb();
  const row = db.query("SELECT id FROM repos WHERE name = ?").get(name) as { id: number } | null;
  return row?.id ?? null;
}

// List relationships for a repo (both directions)
relationships.get("/:repoName/relationships", (c) => {
  const repoName = c.req.param("repoName");
  const repoId = resolveRepoId(repoName);
  if (repoId === null) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const db = getDb();
  const rows = db.query(
    `SELECT
       rr.source_repo_id, rr.target_repo_id, rr.relationship, rr.description,
       s.name as source_name, t.name as target_name
     FROM repo_relationships rr
     JOIN repos s ON s.id = rr.source_repo_id
     JOIN repos t ON t.id = rr.target_repo_id
     WHERE rr.source_repo_id = ? OR rr.target_repo_id = ?`
  ).all(repoId, repoId);

  return c.json(rows);
});

// Add a relationship between two repos
relationships.post("/:repoName/relationships", async (c) => {
  const repoName = c.req.param("repoName");
  const body = await c.req.json<{
    target_repo: string;
    relationship: string;
    description?: string;
  }>();

  if (!body.target_repo || !body.relationship) {
    return c.json({ error: "target_repo and relationship are required" }, 400);
  }

  const sourceId = resolveRepoId(repoName);
  if (sourceId === null) {
    return c.json({ error: `Repo not found: ${repoName}` }, 404);
  }

  const targetId = resolveRepoId(body.target_repo);
  if (targetId === null) {
    return c.json({ error: `Repo not found: ${body.target_repo}` }, 404);
  }

  if (sourceId === targetId) {
    return c.json({ error: "Cannot relate a repo to itself" }, 400);
  }

  const db = getDb();
  try {
    db.run(
      `INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description)
       VALUES (?, ?, ?, ?)`,
      [sourceId, targetId, body.relationship, body.description ?? null]
    );
  } catch (err) {
    // Composite PK conflict means duplicate
    if (String(err).includes("UNIQUE constraint")) {
      return c.json({ error: "Relationship already exists" }, 409);
    }
    throw err;
  }

  logger.info("Repo relationship added", {
    source: repoName,
    target: body.target_repo,
    relationship: body.relationship,
  });

  return c.json({
    source_repo: repoName,
    target_repo: body.target_repo,
    relationship: body.relationship,
    description: body.description ?? null,
  }, 201);
});

// Delete a relationship
relationships.delete("/:repoName/relationships", async (c) => {
  const repoName = c.req.param("repoName");
  const body = await c.req.json<{
    target_repo: string;
    relationship: string;
  }>();

  if (!body.target_repo || !body.relationship) {
    return c.json({ error: "target_repo and relationship are required" }, 400);
  }

  const sourceId = resolveRepoId(repoName);
  if (sourceId === null) {
    return c.json({ error: `Repo not found: ${repoName}` }, 404);
  }

  const targetId = resolveRepoId(body.target_repo);
  if (targetId === null) {
    return c.json({ error: `Repo not found: ${body.target_repo}` }, 404);
  }

  const db = getDb();
  const result = db.run(
    `DELETE FROM repo_relationships
     WHERE source_repo_id = ? AND target_repo_id = ? AND relationship = ?`,
    [sourceId, targetId, body.relationship]
  );

  if (result.changes === 0) {
    return c.json({ error: "Relationship not found" }, 404);
  }

  logger.info("Repo relationship removed", {
    source: repoName,
    target: body.target_repo,
    relationship: body.relationship,
  });

  return c.json({ removed: true });
});

// List ALL relationships (not scoped to a repo)
relationships.get("/relationships", (c) => {
  const db = getDb();
  const rows = db.query(
    `SELECT
       rr.source_repo_id, rr.target_repo_id, rr.relationship, rr.description,
       s.name as source_name, t.name as target_name
     FROM repo_relationships rr
     JOIN repos s ON s.id = rr.source_repo_id
     JOIN repos t ON t.id = rr.target_repo_id
     ORDER BY s.name, t.name`
  ).all();

  return c.json(rows);
});

export { relationships };
