import { Hono } from "hono";
import { $ } from "bun";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { search } from "../../knowledge/search";
import type { SearchResult } from "../../knowledge/search";
import { indexRepo } from "../../knowledge/indexer";
import { parseRepo } from "../../knowledge/repo-parser";
import { logger } from "../../shared/logger";
import type { Repo } from "../../shared/types";
import { claudeStream } from "../../shared/claude-cli";

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

knowledge.post("/files", async (c) => {
  const body = await c.req.json<{ repo_name: string; pattern?: string }>();
  const db = getDb();

  const repo = db.query("SELECT id, path FROM repos WHERE name = ?").get(body.repo_name) as { id: number; path: string } | null;
  if (!repo) {
    return c.json({ error: `Repo '${body.repo_name}' not found` }, 404);
  }

  try {
    let output: string;
    if (body.pattern) {
      output = await $`git -C ${repo.path} ls-files -- ${body.pattern}`.text();
    } else {
      output = await $`git -C ${repo.path} ls-files`.text();
    }
    const files = output.trim().split("\n").filter(Boolean);
    return c.json({ files });
  } catch (err) {
    logger.warn("Failed to list files", { error: String(err) });
    return c.json({ files: [] });
  }
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

  // Re-parse repo metadata (commands, language, framework)
  const parsed = await parseRepo(repo.path);
  const updates: Record<string, string | null> = {};
  for (const field of ["build_cmd", "test_cmd", "run_cmd", "lint_cmd", "language", "framework", "docker_compose_path"] as const) {
    if (parsed[field] && parsed[field] !== repoRow[field]) {
      updates[field] = parsed[field];
    }
  }
  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    db.run(
      `UPDATE repos SET ${sets} WHERE id = ?`,
      [...Object.values(updates), repo.id]
    );
    Object.assign(repo, updates);
    logger.info("Updated repo metadata during reindex", { name, updates: Object.keys(updates) });
  }

  logger.info("Reindexing repo", { name });
  const result = await indexRepo(repo);

  return c.json({
    repo: name,
    chunks_indexed: result.chunks,
    embeddings_generated: result.embeddings,
    updated_fields: Object.keys(updates),
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

knowledge.post("/ask", async (c) => {
  const body = await c.req.json<{
    query: string;
    repo_name?: string;
    limit?: number;
  }>();

  if (!body.query?.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

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
    limit: body.limit ?? 8,
  });

  if (results.length === 0) {
    const msg = "No relevant knowledge found. Try indexing repos first with: hoto repos reindex";
    return c.json({ id: null, answer: msg, sources: [] });
  }

  const askId = ulid();
  db.query(
    "INSERT INTO ask_queries (id, query, status) VALUES (?, ?, 'running')"
  ).run(askId, body.query);

  runAskInBackground(askId, body.query, results);

  return c.json({ id: askId, status: "running" });
});

knowledge.get("/ask/:id/stream", (c) => {
  const askId = c.req.param("id");
  const after = parseInt(c.req.query("after") ?? "0", 10) || 0;

  const db = getDb();

  const query = db.query(
    "SELECT status, answer, sources, error FROM ask_queries WHERE id = ?"
  ).get(askId) as { status: string; answer: string | null; sources: string | null; error: string | null } | null;

  if (!query) {
    return c.json({ error: "Ask query not found" }, 404);
  }

  const events = db.query(
    "SELECT id, event_type, content FROM ask_stream WHERE ask_query_id = ? AND id > ? ORDER BY id LIMIT 200"
  ).all(askId, after) as { id: number; event_type: string; content: string }[];

  let sources: unknown[] = [];
  if (query.sources) {
    try { sources = JSON.parse(query.sources); } catch { /* ignore */ }
  }

  return c.json({
    status: query.status,
    events,
    answer: query.answer ?? undefined,
    sources: sources.length > 0 ? sources : undefined,
    error: query.error ?? undefined,
  });
});

function buildAskPrompt(query: string, results: SearchResult[]) {
  const MAX_CONTENT_CHARS = 1200;

  const contextParts = results.map((r, i) => {
    const content = r.content.length > MAX_CONTENT_CHARS
      ? `${r.content.slice(0, MAX_CONTENT_CHARS)}...`
      : r.content;
    return `[${i + 1}] ${r.repo_name}: ${r.source_file} (${r.chunk_type})\n${content}`;
  });

  const context = contextParts.join("\n\n---\n\n");

  return {
    systemPrompt:
      "You are a helpful assistant with access to a codebase knowledge base. " +
      "Answer the user's question based on the provided context. " +
      "Be concise and precise. Reference specific files or code when relevant. " +
      "If the context does not contain enough information to answer, say so clearly.",
    prompt:
      `Question: ${query}\n\nContext from knowledge base:\n\n${context}\n\nAnswer the question based on the context above.`,
  };
}

function runAskInBackground(askId: string, query: string, results: SearchResult[]): void {
  const db = getDb();
  const { systemPrompt, prompt } = buildAskPrompt(query, results);

  const insertEvent = db.query(
    "INSERT INTO ask_stream (ask_query_id, event_type, content) VALUES (?, ?, ?)"
  );

  claudeStream(
    { prompt, systemPrompt },
    async (evt) => {
      insertEvent.run(askId, evt.type, evt.content);
    },
  ).then((result) => {
    if (result.error) {
      db.query(
        "UPDATE ask_queries SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"
      ).run(result.error, askId);
    } else {
      db.query(
        "UPDATE ask_queries SET status = 'completed', answer = ?, sources = ?, finished_at = datetime('now') WHERE id = ?"
      ).run(result.text, JSON.stringify(results), askId);
    }
  }).catch((err) => {
    logger.error("Background ask failed", { askId, error: String(err) });
    db.query(
      "UPDATE ask_queries SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(String(err), askId);
  });
}

export { knowledge };
