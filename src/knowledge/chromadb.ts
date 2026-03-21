import { ChromaClient, type Collection } from "chromadb";
import { config } from "../shared/config";
import { logger } from "../shared/logger";

let _client: ChromaClient | null = null;
const _collections = new Map<string, Collection>();

export function getChromaClient(): ChromaClient {
  if (_client) return _client;
  _client = new ChromaClient({ path: config.chromaUrl });
  return _client;
}

export async function getOrCreateCollection(repoName: string): Promise<Collection> {
  const cached = _collections.get(repoName);
  if (cached) return cached;

  const client = getChromaClient();
  const collectionName = `hoto-${repoName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 63);

  const collection = await client.getOrCreateCollection({
    name: collectionName,
    metadata: { "hnsw:space": "cosine" },
  });

  _collections.set(repoName, collection);
  return collection;
}

export async function isChromaAvailable(): Promise<boolean> {
  try {
    const client = getChromaClient();
    await client.heartbeat();
    return true;
  } catch {
    return false;
  }
}

export async function deleteCollectionItems(
  repoName: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const collection = await getOrCreateCollection(repoName);
    // ChromaDB has batch size limits, delete in chunks
    const BATCH = 5000;
    for (let i = 0; i < ids.length; i += BATCH) {
      await collection.delete({ ids: ids.slice(i, i + BATCH) });
    }
  } catch (err) {
    logger.warn("ChromaDB delete failed", { repoName, error: String(err) });
  }
}
