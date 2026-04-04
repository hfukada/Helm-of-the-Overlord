import { ChromaClient } from "chromadb";
import type { Collection } from "chromadb";
import { OllamaEmbeddingFunction } from "@chroma-core/ollama";
import { config } from "../shared/config";
import { logger } from "../shared/logger";

const OLLAMA_URL = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.HOTO_EMBED_MODEL ?? "nomic-embed-text";

let _client: ChromaClient | null = null;
let _embedder: OllamaEmbeddingFunction | null = null;
const _collections = new Map<string, Collection>();

function getClient(): ChromaClient {
  if (!_client) {
    const url = new URL(config.chromaUrl);
    _client = new ChromaClient({
      host: url.hostname,
      port: parseInt(url.port || "8033", 10),
      ssl: url.protocol === "https:",
    });
  }
  return _client;
}

function getEmbedder(): OllamaEmbeddingFunction {
  if (!_embedder) {
    _embedder = new OllamaEmbeddingFunction({
      url: `${OLLAMA_URL}/`,
      model: EMBED_MODEL,
    });
  }
  return _embedder;
}

async function getCollection(repoName: string): Promise<Collection> {
  const cached = _collections.get(repoName);
  if (cached) return cached;

  const client = getClient();
  const embedder = getEmbedder();
  const collectionName = `hoto-${repoName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 63);

  const collection = await client.getOrCreateCollection({
    name: collectionName,
    embeddingFunction: embedder,
    metadata: { "hnsw:space": "cosine" },
  });

  _collections.set(repoName, collection);
  return collection;
}

export async function isChromaAvailable(): Promise<boolean> {
  try {
    const client = getClient();
    await client.heartbeat();
    return true;
  } catch {
    return false;
  }
}

export async function upsertDocuments(
  repoName: string,
  ids: string[],
  documents: string[],
  metadatas: Array<Record<string, string>>
): Promise<void> {
  if (ids.length === 0) return;

  // nomic-embed-text has ~8192 token context. Truncate long documents to stay under limit.
  const MAX_CHARS = 6000;
  const truncated = documents.map((d) => d.length > MAX_CHARS ? d.slice(0, MAX_CHARS) : d);

  const collection = await getCollection(repoName);

  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    await collection.upsert({
      ids: ids.slice(i, i + BATCH),
      documents: truncated.slice(i, i + BATCH),
      metadatas: metadatas.slice(i, i + BATCH),
    });
  }
}

export interface ChromaQueryResult {
  id: string;
  document: string;
  metadata: Record<string, string>;
  distance: number;
}

export async function queryDocuments(
  repoName: string,
  queryText: string,
  nResults: number = 20,
  where?: Record<string, string>
): Promise<ChromaQueryResult[]> {
  const collection = await getCollection(repoName);

  const queryOpts: {
    queryTexts: string[];
    nResults: number;
    where?: Record<string, string>;
  } = {
    queryTexts: [queryText],
    nResults,
  };
  if (where && Object.keys(where).length > 0) {
    queryOpts.where = where;
  }

  const results = await collection.query(queryOpts);

  if (!results.ids[0]) return [];

  return results.ids[0].map((id, i) => ({
    id: id ?? "",
    document: results.documents[0]?.[i] ?? "",
    metadata: (results.metadatas[0]?.[i] as Record<string, string>) ?? {},
    distance: results.distances?.[0]?.[i] ?? 1,
  }));
}

export async function deleteCollectionItems(
  repoName: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  try {
    const collection = await getCollection(repoName);
    const BATCH = 5000;
    for (let i = 0; i < ids.length; i += BATCH) {
      await collection.delete({ ids: ids.slice(i, i + BATCH) });
    }
  } catch (err) {
    logger.warn("ChromaDB delete failed", { repoName, error: String(err) });
  }
}
