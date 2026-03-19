import { Hono } from "hono";
import { getDb } from "../../knowledge/db";
import { search } from "../../knowledge/search";
import { indexRepo } from "../../knowledge/indexer";
import { logger } from "../../shared/logger";
import type { Repo } from "../../shared/types";

const knowledge = new Hono();

knowledge.post("/search", async (c) => {
  const body = await c.req.json<{
    query: string;
    repo_name?: string;
    chunk_type?: string;
    limit?: number;
  }>();

  const db = getDb();
  let repoId: number | undefined;

  if (body.repo_name) {
    const repo = db.query("SELECT id FROM repos WHERE name = ?").get(body.repo_name) as { id: number } | null;
    if (!repo) {
      return c.json({ error: `Repo '${body.repo_name}' not found` }, 404);
    }
    repoId = repo.id;
  }

  const results = await search({
    query: body.query,
    repo_id: repoId,
    chunk_type: body.chunk_type,
    limit: body.limit,
  });

  return c.json({ results, count: results.length });
});

knowledge.post("/repos/:name/reindex", async (c) => {
  const name = c.req.param("name");
  const db = getDb();

  const repoRow = db.query("SELECT * FROM repos WHERE name = ?").get(name) as Record<string, unknown> | null;
  if (!repoRow) {
    return c.json({ error: `Repo '${name}' not found` }, 404);
  }

  const repo: Repo = {
    id: repoRow.id as number,
    name: repoRow.name as string,
    path: repoRow.path as string,
    description: repoRow.description as string | null,
    build_cmd: repoRow.build_cmd as string | null,
    test_cmd: repoRow.test_cmd as string | null,
    run_cmd: repoRow.run_cmd as string | null,
    lint_cmd: repoRow.lint_cmd as string | null,
    language: repoRow.language as string | null,
    framework: repoRow.framework as string | null,
    docker_compose_path: repoRow.docker_compose_path as string | null,
    metadata: null,
  };

  logger.info("Reindexing repo", { name });
  const result = await indexRepo(repo);

  return c.json({
    repo: name,
    chunks_indexed: result.chunks,
    embeddings_generated: result.embeddings,
  });
});

knowledge.get("/repos/:name/chunks", (c) => {
  const name = c.req.param("name");
  const db = getDb();

  const repo = db.query("SELECT id FROM repos WHERE name = ?").get(name) as { id: number } | null;
  if (!repo) {
    return c.json({ error: `Repo '${name}' not found` }, 404);
  }

  const chunks = db.query(
    `SELECT id, source_file, chunk_type, title, LENGTH(content) as content_length
     FROM knowledge_chunks WHERE repo_id = ? ORDER BY id`
  ).all(repo.id);

  const embeddingCount = db.query(
    `SELECT COUNT(*) as count FROM knowledge_embeddings ke
     JOIN knowledge_chunks kc ON kc.id = ke.chunk_id
     WHERE kc.repo_id = ?`
  ).get(repo.id) as { count: number };

  return c.json({ chunks, embedding_count: embeddingCount.count });
});

export { knowledge };
