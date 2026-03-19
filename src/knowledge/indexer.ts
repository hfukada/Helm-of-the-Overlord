import { readFile } from "fs/promises";
import { join, relative } from "path";
import { existsSync } from "fs";
import { $ } from "bun";
import { getDb } from "./db";
import { embed, embedBatch, isOllamaAvailable } from "./embeddings";
import { logger } from "../shared/logger";
import type { Repo } from "../shared/types";

type ChunkType =
  | "readme"
  | "api_doc"
  | "build_instructions"
  | "architecture"
  | "code_pattern"
  | "config"
  | "changelog";

interface Chunk {
  source_file: string;
  chunk_type: ChunkType;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

const INDEXABLE_FILES: Array<{ pattern: string; type: ChunkType; title: string }> = [
  { pattern: "README.md", type: "readme", title: "README" },
  { pattern: "README", type: "readme", title: "README" },
  { pattern: "CONTRIBUTING.md", type: "build_instructions", title: "Contributing Guide" },
  { pattern: "ARCHITECTURE.md", type: "architecture", title: "Architecture" },
  { pattern: "CLAUDE.md", type: "build_instructions", title: "Claude Instructions" },
  { pattern: "CHANGELOG.md", type: "changelog", title: "Changelog" },
  { pattern: "docs/README.md", type: "api_doc", title: "Docs README" },
];

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt",
]);

const MAX_CHUNK_SIZE = 2000; // characters per chunk
const MAX_FILE_SIZE = 100_000; // skip files larger than 100KB

export async function indexRepo(repo: Repo): Promise<{ chunks: number; embeddings: number }> {
  const db = getDb();
  const repoPath = repo.path;

  logger.info("Indexing repo", { name: repo.name, path: repoPath });

  // Clear existing chunks for this repo
  db.run("DELETE FROM knowledge_chunks WHERE repo_id = ?", [repo.id]);

  const chunks: Chunk[] = [];

  // Index known documentation files
  for (const entry of INDEXABLE_FILES) {
    const filePath = join(repoPath, entry.pattern);
    if (!existsSync(filePath)) continue;

    try {
      const content = await readFile(filePath, "utf-8");
      const fileChunks = splitIntoChunks(content, entry.type, entry.title, entry.pattern);
      chunks.push(...fileChunks);
    } catch (err) {
      logger.warn("Failed to read file for indexing", { file: filePath, error: String(err) });
    }
  }

  // Index package.json / pyproject.toml / Cargo.toml as config
  for (const configFile of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const filePath = join(repoPath, configFile);
    if (!existsSync(filePath)) continue;

    try {
      const content = await readFile(filePath, "utf-8");
      chunks.push({
        source_file: configFile,
        chunk_type: "config",
        title: configFile,
        content: content.slice(0, MAX_CHUNK_SIZE),
        metadata: {},
      });
    } catch {}
  }

  // Find and index key source files (entry points, main modules)
  try {
    const gitFiles = await $`git -C ${repoPath} ls-files`.text();
    const files = gitFiles.trim().split("\n").filter(Boolean);

    const entryPatterns = [
      /^src\/index\.\w+$/,
      /^src\/main\.\w+$/,
      /^src\/app\.\w+$/,
      /^lib\/index\.\w+$/,
      /^main\.\w+$/,
      /^app\.\w+$/,
      /routes/i,
      /schema/i,
      /model/i,
      /types/i,
    ];

    for (const file of files) {
      const ext = file.slice(file.lastIndexOf("."));
      if (!CODE_EXTENSIONS.has(ext)) continue;

      const isEntry = entryPatterns.some((p) => p.test(file));
      if (!isEntry) continue;

      const filePath = join(repoPath, file);
      try {
        const content = await readFile(filePath, "utf-8");
        if (content.length > MAX_FILE_SIZE) continue;

        const fileChunks = splitIntoChunks(content, "code_pattern", file, file);
        chunks.push(...fileChunks);
      } catch {}
    }
  } catch (err) {
    logger.warn("Failed to list git files", { error: String(err) });
  }

  // Insert chunks into DB
  const insertChunk = db.prepare(
    `INSERT INTO knowledge_chunks (repo_id, source_file, chunk_type, title, content, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const insertTx = db.transaction((items: Chunk[]) => {
    for (const chunk of items) {
      insertChunk.run(
        repo.id,
        chunk.source_file,
        chunk.chunk_type,
        chunk.title,
        chunk.content,
        JSON.stringify(chunk.metadata)
      );
    }
  });

  insertTx(chunks);
  logger.info("Indexed chunks", { repo: repo.name, count: chunks.length });

  // Generate embeddings if Ollama is available
  let embeddingCount = 0;
  const ollamaReady = await isOllamaAvailable();

  if (ollamaReady) {
    embeddingCount = await generateEmbeddings(repo.id);
  } else {
    logger.warn("Ollama not available, skipping embeddings", { repo: repo.name });
  }

  return { chunks: chunks.length, embeddings: embeddingCount };
}

async function generateEmbeddings(repoId: number): Promise<number> {
  const db = getDb();

  const chunkRows = db.query(
    `SELECT kc.id, kc.content FROM knowledge_chunks kc
     LEFT JOIN knowledge_embeddings ke ON ke.chunk_id = kc.id
     WHERE kc.repo_id = ? AND ke.chunk_id IS NULL`
  ).all(repoId) as Array<{ id: number; content: string }>;

  if (chunkRows.length === 0) return 0;

  logger.info("Generating embeddings", { count: chunkRows.length });

  const BATCH_SIZE = 32;
  const insertEmbed = db.prepare(
    "INSERT OR REPLACE INTO knowledge_embeddings (chunk_id, embedding, model) VALUES (?, ?, ?)"
  );
  let total = 0;

  for (let i = 0; i < chunkRows.length; i += BATCH_SIZE) {
    const batch = chunkRows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content.slice(0, 8000)); // Ollama context limit

    try {
      const results = await embedBatch(texts);
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const buf = new Float32Array(results[j].embedding);
          insertEmbed.run(
            batch[j].id,
            Buffer.from(buf.buffer),
            results[j].model
          );
        }
      });
      tx();
      total += batch.length;
    } catch (err) {
      logger.error("Embedding batch failed", { error: String(err), offset: i });
    }
  }

  logger.info("Embeddings generated", { count: total });
  return total;
}

function splitIntoChunks(
  content: string,
  chunkType: ChunkType,
  title: string,
  sourceFile: string
): Chunk[] {
  if (content.length <= MAX_CHUNK_SIZE) {
    return [{ source_file: sourceFile, chunk_type: chunkType, title, content, metadata: {} }];
  }

  const chunks: Chunk[] = [];
  // Split on double newlines (paragraph boundaries) or section headers
  const sections = content.split(/\n(?=#{1,3}\s)|(?:\n\n)/);
  let current = "";
  let partIndex = 0;

  for (const section of sections) {
    if (current.length + section.length > MAX_CHUNK_SIZE && current.length > 0) {
      chunks.push({
        source_file: sourceFile,
        chunk_type: chunkType,
        title: `${title} (part ${partIndex + 1})`,
        content: current.trim(),
        metadata: { part: partIndex },
      });
      partIndex++;
      current = section;
    } else {
      current += (current ? "\n\n" : "") + section;
    }
  }

  if (current.trim()) {
    chunks.push({
      source_file: sourceFile,
      chunk_type: chunkType,
      title: `${title} (part ${partIndex + 1})`,
      content: current.trim(),
      metadata: { part: partIndex },
    });
  }

  return chunks;
}
