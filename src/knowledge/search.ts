import { getDb } from "./db";
import { isChromaAvailable, getOrCreateCollection } from "./chromadb";
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
  const chromaReady = await isChromaAvailable();

  let vectorResults: SearchResult[] = [];
  if (chromaReady) {
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
  const limit = opts.limit ?? 20;

  // Find repo name for collection lookup
  let repoName: string | null = null;
  if (opts.repo_id) {
    const row = db.query("SELECT name FROM repos WHERE id = ?").get(opts.repo_id) as { name: string } | null;
    repoName = row?.name ?? null;
  }

  // If no specific repo, search all repos
  const repoNames: string[] = [];
  if (repoName) {
    repoNames.push(repoName);
  } else {
    const rows = db.query("SELECT name FROM repos").all() as Array<{ name: string }>;
    repoNames.push(...rows.map((r) => r.name));
  }

  const allResults: SearchResult[] = [];

  for (const name of repoNames) {
    try {
      const collection = await getOrCreateCollection(name);
      const whereFilter: Record<string, string> = {};
      if (opts.chunk_type) {
        whereFilter["chunk_type"] = opts.chunk_type;
      }

      const queryOpts: {
        queryTexts: string[];
        nResults: number;
        where?: Record<string, string>;
      } = {
        queryTexts: [opts.query],
        nResults: limit,
      };
      if (Object.keys(whereFilter).length > 0) {
        queryOpts.where = whereFilter;
      }

      const results = await collection.query(queryOpts);

      if (results.ids[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
          const meta = results.metadatas?.[0]?.[i] as Record<string, string> | undefined;
          const distance = results.distances?.[0]?.[i] ?? 1;
          // ChromaDB returns distances; convert to similarity score (cosine distance -> similarity)
          const score = 1 - distance;

          allResults.push({
            chunk_id: 0, // ChromaDB results don't have SQLite IDs
            repo_id: meta?.repo_id ? parseInt(meta.repo_id, 10) : 0,
            repo_name: meta?.repo_name ?? name,
            source_file: meta?.source_file ?? "",
            chunk_type: meta?.chunk_type ?? "",
            title: meta?.title ?? "",
            content: results.documents?.[0]?.[i] ?? "",
            score,
            match_type: "vector" as const,
          });
        }
      }
    } catch (err) {
      logger.warn("ChromaDB vector search failed for repo", { repo: name, error: String(err) });
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

function mergeResults(
  keyword: SearchResult[],
  vector: SearchResult[],
  limit: number
): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  // Use source_file + content prefix as dedup key since ChromaDB results lack chunk_id
  const key = (r: SearchResult) => `${r.repo_name}:${r.source_file}:${r.content.slice(0, 100)}`;

  // Add keyword results
  for (const r of keyword) {
    merged.set(key(r), r);
  }

  // Merge vector results, combining scores for overlaps
  for (const r of vector) {
    const k = key(r);
    const existing = merged.get(k);
    if (existing) {
      // Hybrid score: weighted combination
      existing.score = existing.score * 0.3 + r.score * 0.7;
      existing.match_type = "hybrid";
    } else {
      merged.set(k, r);
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
