import { config } from "../shared/config";
import { logger } from "../shared/logger";

// Direct REST client for ChromaDB -- avoids the JS client's requirement
// for a local embedding function. The ChromaDB server handles embedding
// with its built-in model (all-MiniLM-L6-v2).

const collectionIds = new Map<string, string>();

function chromaUrl(path: string): string {
  return `${config.chromaUrl}${path}`;
}

async function chromaFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(chromaUrl(path), {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers as Record<string, string> ?? {}) },
  });
}

export async function isChromaAvailable(): Promise<boolean> {
  try {
    const res = await chromaFetch("/api/v1/heartbeat", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getOrCreateCollectionId(repoName: string): Promise<string> {
  const cached = collectionIds.get(repoName);
  if (cached) return cached;

  const collectionName = `hoto-${repoName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 63);

  // Try to get existing
  const getRes = await chromaFetch(`/api/v1/collections/${collectionName}`);
  if (getRes.ok) {
    const data = await getRes.json() as { id: string };
    collectionIds.set(repoName, data.id);
    return data.id;
  }

  // Create new
  const createRes = await chromaFetch("/api/v1/collections", {
    method: "POST",
    body: JSON.stringify({
      name: collectionName,
      metadata: { "hnsw:space": "cosine" },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Failed to create ChromaDB collection: ${createRes.status} ${body}`);
  }

  const data = await createRes.json() as { id: string };
  collectionIds.set(repoName, data.id);
  return data.id;
}

export async function upsertDocuments(
  repoName: string,
  ids: string[],
  documents: string[],
  metadatas: Array<Record<string, string>>
): Promise<void> {
  if (ids.length === 0) return;

  const collectionId = await getOrCreateCollectionId(repoName);

  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await chromaFetch(`/api/v1/collections/${collectionId}/upsert`, {
      method: "POST",
      body: JSON.stringify({
        ids: ids.slice(i, i + BATCH),
        documents: documents.slice(i, i + BATCH),
        metadatas: metadatas.slice(i, i + BATCH),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn("ChromaDB upsert failed", { repoName, status: res.status, body: body.slice(0, 200) });
    }
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
  const collectionId = await getOrCreateCollectionId(repoName);

  const body: Record<string, unknown> = {
    query_texts: [queryText],
    n_results: nResults,
  };
  if (where && Object.keys(where).length > 0) {
    body.where = where;
  }

  const res = await chromaFetch(`/api/v1/collections/${collectionId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ChromaDB query failed: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    ids: string[][];
    documents: (string | null)[][];
    metadatas: (Record<string, string> | null)[][];
    distances: number[][];
  };

  if (!data.ids[0]) return [];

  return data.ids[0].map((id, i) => ({
    id,
    document: data.documents[0][i] ?? "",
    metadata: data.metadatas[0][i] ?? {},
    distance: data.distances[0][i] ?? 1,
  }));
}

export async function deleteCollectionItems(
  repoName: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  try {
    const collectionId = await getOrCreateCollectionId(repoName);
    const BATCH = 5000;
    for (let i = 0; i < ids.length; i += BATCH) {
      await chromaFetch(`/api/v1/collections/${collectionId}/delete`, {
        method: "POST",
        body: JSON.stringify({ ids: ids.slice(i, i + BATCH) }),
      });
    }
  } catch (err) {
    logger.warn("ChromaDB delete failed", { repoName, error: String(err) });
  }
}
