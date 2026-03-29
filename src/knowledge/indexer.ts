import { readFile } from "node:fs/promises";
import { join, } from "node:path";
import { existsSync } from "node:fs";
import { $ } from "bun";
import { getDb } from "./db";
import { upsertDocuments, deleteCollectionItems } from "./chromadb";
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
  | "chat_history"
  | "repo_commands";

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
  { pattern: "DEVELOPMENT.md", type: "build_instructions", title: "Development Guide" },
  { pattern: "CHANGELOG.md", type: "changelog", title: "Changelog" },
  { pattern: "docs/README.md", type: "api_doc", title: "Docs README" },
];

/** Files to scan for test/lint/build command hints. */
const COMMAND_HINT_FILES = [
  "README.md", "CLAUDE.md", "DEVELOPMENT.md", "CONTRIBUTING.md",
  "docs/README.md", "docs/DEVELOPMENT.md",
];

/**
 * Scan documentation files for test/lint/build command patterns.
 * Returns discovered commands (only fills in missing values).
 */
async function detectCommandsFromDocs(
  repoPath: string,
  existing: { test_cmd: string | null; lint_cmd: string | null; build_cmd: string | null }
): Promise<{ test_cmd: string | null; lint_cmd: string | null; build_cmd: string | null }> {
  const result = { ...existing };
  const allMissing = !result.test_cmd && !result.lint_cmd && !result.build_cmd;
  if (!allMissing && result.test_cmd && result.lint_cmd && result.build_cmd) {
    return result; // all already known
  }

  let combined = "";
  for (const file of COMMAND_HINT_FILES) {
    const filePath = join(repoPath, file);
    if (existsSync(filePath)) {
      try {
        combined += `${await readFile(filePath, "utf-8")}\n`;
      } catch {}
    }
  }
  if (!combined) return result;

  // Extract code blocks and lines that look like shell commands
  const codeBlocks = combined.match(/```(?:sh|bash|shell|zsh|console)?\n([\s\S]*?)```/g) ?? [];
  const commandLines = codeBlocks.map((b) => b.replace(/```\w*\n?/g, "")).join("\n");

  // Test command patterns
  if (!result.test_cmd) {
    const testPatterns = [
      /^(bun\s+(?:run\s+)?test\b.*)/m,
      /^(npm\s+(?:run\s+)?test\b.*)/m,
      /^(yarn\s+(?:run\s+)?test\b.*)/m,
      /^(pnpm\s+(?:run\s+)?test\b.*)/m,
      /^(pytest\b.*)/m,
      /^(python\s+-m\s+pytest\b.*)/m,
      /^(go\s+test\b.*)/m,
      /^(cargo\s+test\b.*)/m,
      /^(mvn\s+test\b.*)/m,
      /^(make\s+test\b.*)/m,
    ];
    for (const p of testPatterns) {
      const m = commandLines.match(p);
      if (m) { result.test_cmd = m[1].trim(); break; }
    }
  }

  // Lint command patterns
  if (!result.lint_cmd) {
    const lintPatterns = [
      /^(bun\s+(?:run\s+)?lint\b.*)/m,
      /^(npm\s+(?:run\s+)?lint\b.*)/m,
      /^(yarn\s+(?:run\s+)?lint\b.*)/m,
      /^(pnpm\s+(?:run\s+)?lint\b.*)/m,
      /^(ruff\s+check\b.*)/m,
      /^(flake8\b.*)/m,
      /^(golangci-lint\s+run\b.*)/m,
      /^(cargo\s+clippy\b.*)/m,
      /^(make\s+lint\b.*)/m,
    ];
    for (const p of lintPatterns) {
      const m = commandLines.match(p);
      if (m) { result.lint_cmd = m[1].trim(); break; }
    }
  }

  // Build command patterns
  if (!result.build_cmd) {
    const buildPatterns = [
      /^(bun\s+(?:run\s+)?build\b.*)/m,
      /^(npm\s+(?:run\s+)?build\b.*)/m,
      /^(yarn\s+(?:run\s+)?build\b.*)/m,
      /^(pnpm\s+(?:run\s+)?build\b.*)/m,
      /^(go\s+build\b.*)/m,
      /^(cargo\s+build\b.*)/m,
      /^(mvn\s+(?:compile|package)\b.*)/m,
      /^(make\s+build\b.*)/m,
    ];
    for (const p of buildPatterns) {
      const m = commandLines.match(p);
      if (m) { result.build_cmd = m[1].trim(); break; }
    }
  }

  return result;
}

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

export async function indexRepo(repo: Repo, opts?: { force?: boolean }): Promise<{ chunks: number; embeddings: number }> {
  const db = getDb();
  const repoPath = repo.path;
  const force = opts?.force ?? false;

  logger.info("Indexing repo", { name: repo.name, path: repoPath, force });

  // Pull latest from remote before diffing
  try {
    await $`git -C ${repoPath} pull --ff-only`.quiet();
  } catch (err) {
    logger.warn("Git pull failed, indexing from local state", { repo: repo.name, error: String(err) });
  }

  if (force) {
    // Clear all existing chunks and reset hash to force full reindex
    logger.info("Force reindex: clearing existing chunks", { repo: repo.name });
    db.run("DELETE FROM knowledge_chunks WHERE repo_id = ?", [repo.id]);
    db.run("UPDATE repos SET index_commit_hash = NULL WHERE id = ?", [repo.id]);
  }

  const currentHash = await getHeadCommit(repoPath);
  const storedHash = force ? null : (db.query("SELECT index_commit_hash FROM repos WHERE id = ?").get(repo.id) as { index_commit_hash: string | null } | null)?.index_commit_hash;

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
      const chromaIds = changed.map((f) => `${repo.id}-${f}`);
      await deleteCollectionItems(repo.name, chromaIds);
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

  // Detect test/lint/build commands from documentation if missing
  const detectedCmds = await detectCommandsFromDocs(repoPath, {
    test_cmd: repo.test_cmd,
    lint_cmd: repo.lint_cmd,
    build_cmd: repo.build_cmd,
  });

  // Update repo in DB if we discovered new commands
  const cmdUpdates: string[] = [];
  const cmdValues: (string | number)[] = [];
  for (const field of ["test_cmd", "lint_cmd", "build_cmd"] as const) {
    if (detectedCmds[field] && detectedCmds[field] !== repo[field]) {
      cmdUpdates.push(`${field} = ?`);
      cmdValues.push(detectedCmds[field] as string);
    }
  }
  if (cmdUpdates.length > 0) {
    cmdValues.push(repo.id);
    db.run(`UPDATE repos SET ${cmdUpdates.join(", ")} WHERE id = ?`, cmdValues);
    logger.info("Updated repo commands from docs", {
      repo: repo.name,
      updates: cmdUpdates.map((u) => u.split(" ")[0]),
    });
  }

  // Add a repo_commands summary chunk (always refreshed)
  db.run("DELETE FROM knowledge_chunks WHERE repo_id = ? AND chunk_type = 'repo_commands'", [repo.id]);
  const cmdLines: string[] = [];
  if (detectedCmds.build_cmd || repo.build_cmd) cmdLines.push(`Build: ${detectedCmds.build_cmd ?? repo.build_cmd}`);
  if (detectedCmds.test_cmd || repo.test_cmd) cmdLines.push(`Test: ${detectedCmds.test_cmd ?? repo.test_cmd}`);
  if (detectedCmds.lint_cmd || repo.lint_cmd) cmdLines.push(`Lint: ${detectedCmds.lint_cmd ?? repo.lint_cmd}`);
  if (repo.language) cmdLines.push(`Language: ${repo.language}`);
  if (repo.framework) cmdLines.push(`Framework: ${repo.framework}`);
  if (repo.docker_image) cmdLines.push(`Docker Image: ${repo.docker_image}`);
  if (repo.docker_compose_path) cmdLines.push(`Docker Compose: ${repo.docker_compose_path}`);

  if (cmdLines.length > 0) {
    chunks.push({
      source_file: "_repo_commands",
      chunk_type: "repo_commands",
      title: `${repo.name} - Build/Test/Lint Commands`,
      content: cmdLines.join("\n"),
      metadata: {},
    });
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

  // Upsert into ChromaDB
  const embeddingCount = await upsertToChroma(repo, chunks);

  // Update stored commit hash
  if (currentHash) {
    db.run("UPDATE repos SET index_commit_hash = ? WHERE id = ?", [currentHash, repo.id]);
  }

  return { chunks: chunks.length, embeddings: embeddingCount };
}

async function upsertToChroma(repo: Repo, chunks: Chunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  try {
    const ids = chunks.map((c, i) => `${repo.id}-${c.source_file}-${i}`);
    const documents = chunks.map((c) => c.content);
    const metadatas = chunks.map((c) => ({
      repo_id: String(repo.id),
      repo_name: repo.name,
      source_file: c.source_file,
      chunk_type: c.chunk_type,
      title: c.title,
    }));

    await upsertDocuments(repo.name, ids, documents, metadatas);
    logger.info("ChromaDB upsert complete", { repo: repo.name, count: chunks.length });
    return chunks.length;
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

  await upsertToChroma(repo, [chunk]);
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
