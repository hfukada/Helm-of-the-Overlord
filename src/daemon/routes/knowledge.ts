import { Hono } from "hono";
import { $ } from "bun";
import { getDb } from "../../knowledge/db";
import { search } from "../../knowledge/search";
import type { SearchResult } from "../../knowledge/search";
import { indexRepo } from "../../knowledge/indexer";
import { logger } from "../../shared/logger";
import { config } from "../../shared/config";
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
    return c.json({
      answer: "No relevant knowledge found. Try indexing repos first with: hoto repos reindex",
      sources: [],
    });
  }

  let answer: string;
  try {
    answer = await generateAnswer(body.query, results);
  } catch (err) {
    logger.error("Failed to generate answer", { error: String(err) });
    return c.json({ error: `Failed to generate answer: ${String(err)}` }, 500);
  }
  return c.json({ answer, sources: results });
});

async function generateAnswer(query: string, results: SearchResult[]): Promise<string> {
  const MAX_CONTENT_CHARS = 1200;

  const contextParts = results.map((r, i) => {
    const content = r.content.length > MAX_CONTENT_CHARS
      ? `${r.content.slice(0, MAX_CONTENT_CHARS)}...`
      : r.content;
    return `[${i + 1}] ${r.repo_name}: ${r.source_file} (${r.chunk_type})\n${content}`;
  });

  const context = contextParts.join("\n\n---\n\n");

  const systemPrompt =
    "You are a helpful assistant with access to a codebase knowledge base. " +
    "Answer the user's question based on the provided context. " +
    "Be concise and precise. Reference specific files or code when relevant. " +
    "If the context does not contain enough information to answer, say so clearly.";

  const userPrompt =
    `Question: ${query}\n\nContext from knowledge base:\n\n${context}\n\nAnswer the question based on the context above.`;

  const model = config.defaultModel;
  const proc = Bun.spawn(
    ["claude", "--print", "--model", model, "--system-prompt", systemPrompt, "--", userPrompt],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );

  const [output, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    logger.error("claude subprocess failed during ask", { exitCode, stderr });
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`);
  }

  return output.trim();
}

export { knowledge };
