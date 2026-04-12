import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { detectLanguage, parseSource } from "./parser";
import { extractSymbols, type CodeSymbol } from "./symbols";
import { extractReferences } from "./references";

const MAX_FILE_SIZE = 100_000;
const CHARS_PER_TOKEN = 4; // rough estimate

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs",
]);

export interface RepoMapOptions {
  repoPath: string;
  maxTokens?: number;
}

interface FileInfo {
  path: string;
  symbols: CodeSymbol[];
  references: Set<string>;
}

/**
 * Simplified PageRank: iterate a few times to propagate importance scores
 * through the reference graph.
 */
function pageRank(
  files: FileInfo[],
  iterations: number = 10,
  damping: number = 0.85,
): Map<string, number> {
  // Build symbol-to-file index: which file defines which symbol names
  const symbolToFile = new Map<string, string[]>();
  for (const file of files) {
    for (const sym of file.symbols) {
      const existing = symbolToFile.get(sym.name);
      if (existing) {
        existing.push(file.path);
      } else {
        symbolToFile.set(sym.name, [file.path]);
      }
    }
  }

  // Build adjacency: file A references symbol defined in file B -> edge A->B
  const outLinks = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const ref of file.references) {
      const defFiles = symbolToFile.get(ref);
      if (defFiles) {
        for (const defFile of defFiles) {
          if (defFile !== file.path) {
            targets.add(defFile);
          }
        }
      }
    }
    outLinks.set(file.path, targets);
  }

  // Initialize scores
  const n = files.length;
  if (n === 0) return new Map();

  const scores = new Map<string, number>();
  for (const file of files) {
    scores.set(file.path, 1 / n);
  }

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newScores = new Map<string, number>();
    for (const file of files) {
      newScores.set(file.path, (1 - damping) / n);
    }

    for (const file of files) {
      const links = outLinks.get(file.path);
      if (!links || links.size === 0) continue;
      const share = (scores.get(file.path) ?? 0) * damping / links.size;
      for (const target of links) {
        newScores.set(target, (newScores.get(target) ?? 0) + share);
      }
    }

    for (const [path, score] of newScores) {
      scores.set(path, score);
    }
  }

  return scores;
}

function formatSymbol(sym: CodeSymbol): string {
  const prefix = sym.exported ? "+" : "";
  return `${prefix}${sym.kind} ${sym.name}(${sym.line})`;
}

/**
 * Build a compact, PageRank-ranked map of symbols in a repository.
 * Returns a text representation suitable for injection into prompts.
 */
export async function buildRepoMap(opts: RepoMapOptions): Promise<string> {
  const { repoPath, maxTokens = 2000 } = opts;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // List source files via git
  let gitFiles: string[];
  try {
    const output = await $`git -C ${repoPath} ls-files`.text();
    gitFiles = output.trim().split("\n").filter(Boolean);
  } catch {
    return "";
  }

  // Filter to supported source files
  const sourceFiles = gitFiles.filter((f) => {
    const ext = f.slice(f.lastIndexOf("."));
    return CODE_EXTENSIONS.has(ext);
  });

  if (sourceFiles.length === 0) return "";

  // Parse files and extract symbols + references
  const fileInfos: FileInfo[] = [];
  for (const filePath of sourceFiles) {
    const fullPath = join(repoPath, filePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_SIZE) continue;

    const langName = detectLanguage(filePath);
    if (!langName) continue;

    const tree = await parseSource(content, langName);
    if (!tree) continue;

    const symbols = extractSymbols(tree.rootNode, langName);
    const references = extractReferences(tree.rootNode);
    tree.delete();

    if (symbols.length > 0) {
      fileInfos.push({ path: filePath, symbols, references });
    }
  }

  if (fileInfos.length === 0) return "";

  // Rank files by PageRank
  const scores = pageRank(fileInfos);

  // Sort by score descending
  const ranked = [...fileInfos].sort((a, b) => {
    return (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0);
  });

  // Render within token budget
  const lines: string[] = [];
  let totalChars = 0;

  for (const file of ranked) {
    const symbolStrs = file.symbols.map(formatSymbol);
    const line = `${file.path}: ${symbolStrs.join(" ")}`;

    if (totalChars + line.length > maxChars) {
      // Try truncating symbols for this file
      const prefix = `${file.path}: `;
      const remaining = maxChars - totalChars - prefix.length;
      if (remaining > 20) {
        let truncated = prefix;
        for (const s of symbolStrs) {
          if (truncated.length + s.length + 1 > maxChars - totalChars) break;
          truncated += (truncated.length > prefix.length ? " " : "") + s;
        }
        if (truncated.length > prefix.length) {
          lines.push(truncated);
        }
      }
      break;
    }

    lines.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  return lines.join("\n");
}
