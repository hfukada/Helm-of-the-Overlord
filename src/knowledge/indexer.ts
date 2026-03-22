import { readFile } from "node:fs/promises";
import { join, } from "node:path";
import { existsSync } from "node:fs";
import { $ } from "bun";
import { getDb } from "./db";
import { isChromaAvailable, getOrCreateCollection, deleteCollectionItems } from "./chromadb";
import { logger } from "../shared/logger";
import type { Repo } from "../shared/types";

type ChunkType =
  | "readme"
  | "api_doc"
  | "build_instructions"
  | "architecture"
  | "code_pattern"
  | "config"
  | "changelog"
  | "chat_history";

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

async function getHeadCommit(repoPath: string): Promise<string | null> {
  try {
    const hash = await $`git -C ${repoPath} rev-parse HEAD`.text();
    return hash.trim() || null;
  } catch {
    return null;
  }
}

async function isCommitValid(repoPath: string, hash: string): Promise<boolean> {
  try {
    const result = await $`git -C ${repoPath} cat-file -t ${hash}`.quiet().nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function getChangedFiles(repoPath: string, fromHash: string, toHash: string): Promise<string[]> {
  try {
    const output = await $`git -C ${repoPath} diff --name-only ${fromHash}..${toHash}`.text();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function indexRepo(repo: Repo): Promise<{ chunks: number; embeddings: number }> {
  const db = getDb();
  const repoPath = repo.path;

  logger.info("Indexing repo", { name: repo.name, path: repoPath });

  const currentHash = await getHeadCommit(repoPath);
  const storedHash = (db.query("SELECT index_commit_hash FROM repos WHERE id = ?").get(repo.id) as { index_commit_hash: string | null } | null)?.index_commit_hash;

  let changedFileSet: Set<string> | null = null; // null = full reindex

  if (storedHash && currentHash && storedHash !== currentHash) {
    const valid = await isCommitValid(repoPath, storedHash);
    if (valid) {
      const changed = await getChangedFiles(repoPath, storedHash, currentHash);
      if (changed.length === 0) {
        logger.info("No files changed since last index", { repo: repo.name, hash: storedHash });
        db.run("UPDATE repos SET index_commit_hash = ? WHERE id = ?", [currentHash, repo.id]);
        return { chunks: 0, embeddings: 0 };
      }
      changedFileSet = new Set(changed);
      logger.info("Incremental reindex", { repo: repo.name, changedFiles: changed.length });

      // Delete chunks only for changed files
      const deleteStmt = db.prepare("DELETE FROM knowledge_chunks WHERE repo_id = ? AND source_file = ?");
      const deleteTx = db.transaction((files: string[]) => {
        for (const file of files) {
          deleteStmt.run(repo.id, file);
        }
      });
      deleteTx(changed);

      // Also delete from ChromaDB for changed files
      const chromaReady = await isChromaAvailable();
      if (chromaReady) {
        const chromaIds = changed.map((f) => `${repo.id}-${f}`);
        await deleteCollectionItems(repo.name, chromaIds);
      }
    } else {
      logger.info("Stored commit hash invalid, full reindex", { repo: repo.name, storedHash });
      db.run("DELETE FROM knowledge_chunks WHERE repo_id = ?", [repo.id]);
    }
  } else if (storedHash && storedHash === currentHash) {
    logger.info("Repo already indexed at current commit", { repo: repo.name, hash: storedHash });
    return { chunks: 0, embeddings: 0 };
  } else {
    // No stored hash: full reindex
    db.run("DELETE FROM knowledge_chunks WHERE repo_id = ?", [repo.id]);
  }

  const chunks: Chunk[] = [];

  // Index known documentation files
  for (const entry of INDEXABLE_FILES) {
    if (changedFileSet && !changedFileSet.has(entry.pattern)) continue;

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
    if (changedFileSet && !changedFileSet.has(configFile)) continue;

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
      if (changedFileSet && !changedFileSet.has(file)) continue;

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

  // Upsert into ChromaDB if available
  let embeddingCount = 0;
  const chromaReady = await isChromaAvailable();

  if (chromaReady) {
    embeddingCount = await upsertToChroma(repo, chunks);
  } else {
    logger.warn("ChromaDB not available, skipping vector indexing", { repo: repo.name });
  }

  // Update stored commit hash
  if (currentHash) {
    db.run("UPDATE repos SET index_commit_hash = ? WHERE id = ?", [currentHash, repo.id]);
  }

  return { chunks: chunks.length, embeddings: embeddingCount };
}

async function upsertToChroma(repo: Repo, chunks: Chunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  try {
    const collection = await getOrCreateCollection(repo.name);
    const BATCH_SIZE = 100;
    let total = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const ids = batch.map((c, j) => `${repo.id}-${c.source_file}-${i + j}`);
      const documents = batch.map((c) => c.content);
      const metadatas = batch.map((c) => ({
        repo_id: String(repo.id),
        repo_name: repo.name,
        source_file: c.source_file,
        chunk_type: c.chunk_type,
        title: c.title,
      }));

      await collection.upsert({ ids, documents, metadatas });
      total += batch.length;
    }

    logger.info("ChromaDB upsert complete", { repo: repo.name, count: total });
    return total;
  } catch (err) {
    logger.error("ChromaDB upsert failed", { repo: repo.name, error: String(err) });
    return 0;
  }
}

export async function indexChatHistory(
  repo: Repo,
  taskId: string,
  content: string
): Promise<void> {
  const db = getDb();

  const chunk: Chunk = {
    source_file: `chat/${taskId}`,
    chunk_type: "chat_history",
    title: `Chat history for task ${taskId}`,
    content,
    metadata: { taskId },
  };

  db.run(
    `INSERT INTO knowledge_chunks (repo_id, source_file, chunk_type, title, content, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [repo.id, chunk.source_file, chunk.chunk_type, chunk.title, chunk.content, JSON.stringify(chunk.metadata)]
  );

  const chromaReady = await isChromaAvailable();
  if (chromaReady) {
    await upsertToChroma(repo, [chunk]);
  }
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
