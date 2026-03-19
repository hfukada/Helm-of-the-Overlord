

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.HOTO_EMBED_MODEL ?? "nomic-embed-text";
const EMBED_DIMENSIONS = 768;

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

export async function embed(text: string): Promise<EmbeddingResult> {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return { embedding: data.embeddings[0], model: EMBED_MODEL };
}

export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed batch failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings.map((e) => ({ embedding: e, model: EMBED_MODEL }));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(EMBED_MODEL));
  } catch {
    return false;
  }
}

export { EMBED_MODEL, EMBED_DIMENSIONS };
