import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";
import type { ContainerSecret } from "../../shared/types";

const secrets = new Hono();

// List secrets for a repo
secrets.get("/:repoName/secrets", (c) => {
  const repoName = c.req.param("repoName");
  const db = getDb();

  const repo = db.query("SELECT id FROM repos WHERE name = ?").get(repoName) as { id: number } | null;
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  const rows = db.query("SELECT * FROM container_secrets WHERE repo_id = ? ORDER BY key").all(repo.id);
  return c.json(rows);
});

// Add a secret
secrets.post("/:repoName/secrets", async (c) => {
  const repoName = c.req.param("repoName");
  const body = await c.req.json<{
    secret_type: "env_var" | "auth_file";
    key: string;
    value_source: "host_env" | "host_file";
    host_path?: string;
    container_path?: string;
    description?: string;
  }>();

  const db = getDb();
  const repo = db.query("SELECT id FROM repos WHERE name = ?").get(repoName) as { id: number } | null;
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  if (!body.secret_type || !body.key || !body.value_source) {
    return c.json({ error: "secret_type, key, and value_source are required" }, 400);
  }

  if (body.secret_type === "auth_file" && !body.host_path) {
    return c.json({ error: "host_path is required for auth_file secrets" }, 400);
  }

  try {
    const result = db.run(
      `INSERT INTO container_secrets (repo_id, secret_type, key, value_source, host_path, container_path, description, discovered_by, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1)`,
      [
        repo.id,
        body.secret_type,
        body.key,
        body.value_source,
        body.host_path ?? null,
        body.container_path ?? null,
        body.description ?? null,
      ]
    );
    logger.info("Container secret added", { repo: repoName, key: body.key, type: body.secret_type });
    return c.json({ id: Number(result.lastInsertRowid), key: body.key }, 201);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return c.json({ error: `Secret '${body.key}' already exists for this repo` }, 409);
    }
    throw err;
  }
});

// Delete a secret
secrets.delete("/:repoName/secrets/:secretId", (c) => {
  const repoName = c.req.param("repoName");
  const secretId = parseInt(c.req.param("secretId"), 10);
  const db = getDb();

  const repo = db.query("SELECT id FROM repos WHERE name = ?").get(repoName) as { id: number } | null;
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  const result = db.run(
    "DELETE FROM container_secrets WHERE id = ? AND repo_id = ?",
    [secretId, repo.id]
  );

  if (result.changes === 0) {
    return c.json({ error: "Secret not found" }, 404);
  }

  logger.info("Container secret removed", { repo: repoName, secretId });
  return c.json({ removed: secretId });
});

// Mark a secret as verified
secrets.patch("/:repoName/secrets/:secretId", async (c) => {
  const repoName = c.req.param("repoName");
  const secretId = parseInt(c.req.param("secretId"), 10);
  const body = await c.req.json<{ verified?: boolean; description?: string }>();

  const db = getDb();
  const repo = db.query("SELECT id FROM repos WHERE name = ?").get(repoName) as { id: number } | null;
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.verified !== undefined) {
    sets.push("verified = ?");
    params.push(body.verified ? 1 : 0);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    params.push(body.description);
  }

  if (sets.length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  params.push(secretId, repo.id);
  const result = db.run(
    `UPDATE container_secrets SET ${sets.join(", ")} WHERE id = ? AND repo_id = ?`,
    params
  );

  if (result.changes === 0) {
    return c.json({ error: "Secret not found" }, 404);
  }

  return c.json({ updated: secretId });
});

export { secrets };

/** Look up all verified secrets for a repo by ID */
export function getRepoSecrets(repoId: number): ContainerSecret[] {
  const db = getDb();
  const rows = db.query(
    "SELECT * FROM container_secrets WHERE repo_id = ? AND verified = 1"
  ).all(repoId) as ContainerSecret[];
  return rows;
}
