import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";
import { parseRepo } from "../../knowledge/repo-parser";
import { indexRepo } from "../../knowledge/indexer";
import { resolve } from "path";
import type { Repo } from "../../shared/types";

const repos = new Hono();

repos.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM repos ORDER BY name").all();
  return c.json(rows);
});

repos.post("/", async (c) => {
  const body = await c.req.json<{
    path: string;
    name?: string;
    description?: string;
    language?: string;
    framework?: string;
    build_cmd?: string;
    test_cmd?: string;
    run_cmd?: string;
    lint_cmd?: string;
  }>();

  const repoPath = resolve(body.path);

  // Derive name from directory if not provided
  const name = body.name ?? repoPath.split("/").pop() ?? "unknown";

  const db = getDb();

  // Check for duplicates
  const existing = db.query("SELECT id FROM repos WHERE name = ?").get(name);
  if (existing) {
    return c.json({ error: `Repo '${name}' already exists` }, 409);
  }

  // Auto-detect repo metadata
  const parsed = await parseRepo(repoPath);

  const result = db.run(
    `INSERT INTO repos (name, path, description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, docker_compose_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      repoPath,
      body.description ?? parsed.description,
      body.language ?? parsed.language,
      body.framework ?? parsed.framework,
      body.build_cmd ?? parsed.build_cmd,
      body.test_cmd ?? parsed.test_cmd,
      body.run_cmd ?? parsed.run_cmd,
      body.lint_cmd ?? parsed.lint_cmd,
      parsed.docker_compose_path,
    ]
  );

  const repoId = Number(result.lastInsertRowid);
  logger.info("Repo added", { name, path: repoPath, language: parsed.language });

  // Auto-index in background
  const repo: Repo = {
    id: repoId, name, path: repoPath,
    description: body.description ?? parsed.description,
    build_cmd: body.build_cmd ?? parsed.build_cmd,
    test_cmd: body.test_cmd ?? parsed.test_cmd,
    run_cmd: body.run_cmd ?? parsed.run_cmd,
    lint_cmd: body.lint_cmd ?? parsed.lint_cmd,
    language: body.language ?? parsed.language,
    framework: body.framework ?? parsed.framework,
    docker_compose_path: parsed.docker_compose_path,
    metadata: null,
  };
  indexRepo(repo).catch((err) => {
    logger.warn("Auto-indexing failed", { repo: name, error: String(err) });
  });

  return c.json({
    id: repoId, name, path: repoPath,
    language: parsed.language, framework: parsed.framework,
  }, 201);
});

repos.delete("/:name", (c) => {
  const name = c.req.param("name");
  const db = getDb();
  const result = db.run("DELETE FROM repos WHERE name = ?", [name]);
  if (result.changes === 0) {
    return c.json({ error: "Repo not found" }, 404);
  }
  logger.info("Repo removed", { name });
  return c.json({ removed: name });
});

export { repos };
