import { getDb } from "./db";
import { embed, cosineSimilarity } from "./embeddings";
import { isOllamaAvailable } from "./embeddings";
import { logger } from "../shared/logger";

export interface SearchResult {
  chunk_id: number;
  repo_id: number;
  repo_name: string;
  source_file: string;
  chunk_type: string;
  title: string;
  content: string;
  score: number;
  match_type: "vector" | "keyword" | "hybrid";
}

export interface SearchOptions {
  query: string;
  repo_id?: number;
  chunk_type?: string;
  limit?: number;
}

export async function search(opts: SearchOptions): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;

  // Run keyword and vector search in parallel where possible
  const keywordResults = keywordSearch(opts);
  const ollamaReady = await isOllamaAvailable();

  let vectorResults: SearchResult[] = [];
  if (ollamaReady) {
    vectorResults = await vectorSearch(opts);
  }

  // Merge results with score fusion
  return mergeResults(keywordResults, vectorResults, limit);
}

function keywordSearch(opts: SearchOptions): SearchResult[] {
  const db = getDb();
  const words = opts.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length === 0) return [];

  // Build LIKE conditions for each word
  const conditions = words.map(() => "LOWER(kc.content) LIKE ?");
  const params: (string | number)[] = words.map((w) => `%${w}%`);

  let whereClause = conditions.join(" OR ");
  if (opts.repo_id) {
    whereClause = `(${whereClause}) AND kc.repo_id = ?`;
    params.push(opts.repo_id);
  }
  if (opts.chunk_type) {
    whereClause = `(${whereClause}) AND kc.chunk_type = ?`;
    params.push(opts.chunk_type);
  }

  const rows = db.query(
    `SELECT kc.id as chunk_id, kc.repo_id, r.name as repo_name,
            kc.source_file, kc.chunk_type, kc.title, kc.content
     FROM knowledge_chunks kc
     JOIN repos r ON r.id = kc.repo_id
     WHERE ${whereClause}
     LIMIT ?`
  ).all(...params, opts.limit ?? 20) as Array<{
    chunk_id: number;
    repo_id: number;
    repo_name: string;
    source_file: string;
    chunk_type: string;
    title: string;
    content: string;
  }>;

  return rows.map((row) => {
    // Score based on number of matching words
    const contentLower = row.content.toLowerCase();
    const matchCount = words.filter((w) => contentLower.includes(w)).length;
    const score = matchCount / words.length;

    return { ...row, score, match_type: "keyword" as const };
  });
}

async function vectorSearch(opts: SearchOptions): Promise<SearchResult[]> {
  const db = getDb();

  let queryEmbedding: number[];
  try {
    const result = await embed(opts.query);
    queryEmbedding = result.embedding;
  } catch (err) {
    logger.warn("Failed to embed query", { error: String(err) });
    return [];
  }

  // Fetch all embeddings for the relevant scope
  let whereClause = "1=1";
  const params: (string | number)[] = [];
  if (opts.repo_id) {
    whereClause += " AND kc.repo_id = ?";
    params.push(opts.repo_id);
  }
  if (opts.chunk_type) {
    whereClause += " AND kc.chunk_type = ?";
    params.push(opts.chunk_type);
  }

  const rows = db.query(
    `SELECT kc.id as chunk_id, kc.repo_id, r.name as repo_name,
            kc.source_file, kc.chunk_type, kc.title, kc.content,
            ke.embedding
     FROM knowledge_chunks kc
     JOIN repos r ON r.id = kc.repo_id
     JOIN knowledge_embeddings ke ON ke.chunk_id = kc.id
     WHERE ${whereClause}`
  ).all(...params) as Array<{
    chunk_id: number;
    repo_id: number;
    repo_name: string;
    source_file: string;
    chunk_type: string;
    title: string;
    content: string;
    embedding: Buffer;
  }>;

  const scored = rows.map((row) => {
    const storedEmbedding = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4
    );
    const score = cosineSimilarity(queryEmbedding, Array.from(storedEmbedding));

    return {
      chunk_id: row.chunk_id,
      repo_id: row.repo_id,
      repo_name: row.repo_name,
      source_file: row.source_file,
      chunk_type: row.chunk_type,
      title: row.title,
      content: row.content,
      score,
      match_type: "vector" as const,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 20);
}

function mergeResults(
  keyword: SearchResult[],
  vector: SearchResult[],
  limit: number
): SearchResult[] {
  const merged = new Map<number, SearchResult>();

  // Add keyword results
  for (const r of keyword) {
    merged.set(r.chunk_id, r);
  }

  // Merge vector results, combining scores for overlaps
  for (const r of vector) {
    const existing = merged.get(r.chunk_id);
    if (existing) {
      // Hybrid score: weighted combination
      existing.score = existing.score * 0.3 + r.score * 0.7;
      existing.match_type = "hybrid";
    } else {
      merged.set(r.chunk_id, r);
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
