import { join } from "node:path";
import { Parser, Language, type Tree } from "web-tree-sitter";

const WASM_DIR = join(import.meta.dir, "../../node_modules/tree-sitter-wasms/out");

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

let initialized = false;
const languageCache = new Map<string, Language>();

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

async function loadLanguage(langName: string): Promise<Language | null> {
  const cached = languageCache.get(langName);
  if (cached) return cached;

  const wasmPath = join(WASM_DIR, `tree-sitter-${langName}.wasm`);
  try {
    const lang = await Language.load(wasmPath);
    languageCache.set(langName, lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Detect language name from a file extension.
 * Returns null if the extension is not supported.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Parse source code and return the syntax tree.
 * Returns null if the language is unsupported or grammar fails to load.
 */
export async function parseSource(
  content: string,
  langName: string,
): Promise<Tree | null> {
  await ensureInit();

  const lang = await loadLanguage(langName);
  if (!lang) return null;

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  parser.delete();
  return tree;
}

/**
 * Parse a file given its path and content.
 * Detects language from extension. Returns null if unsupported.
 */
export async function parseFile(
  filePath: string,
  content: string,
): Promise<Tree | null> {
  const langName = detectLanguage(filePath);
  if (!langName) return null;
  return parseSource(content, langName);
}
