import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ulid } from "ulid";

import { detectLanguage, parseSource, parseFile } from "../src/treesitter/parser";
import { extractSymbols, type CodeSymbol } from "../src/treesitter/symbols";
import { extractReferences } from "../src/treesitter/references";
import { buildRepoMap } from "../src/treesitter/repo-map";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSymbol(symbols: CodeSymbol[], name: string): CodeSymbol | undefined {
  return symbols.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe("detectLanguage", () => {
  test("maps .ts to typescript", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
  });

  test("maps .tsx to tsx", () => {
    expect(detectLanguage("App.tsx")).toBe("tsx");
  });

  test("maps .py to python", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  test("maps .go to go", () => {
    expect(detectLanguage("handler.go")).toBe("go");
  });

  test("maps .rs to rust", () => {
    expect(detectLanguage("lib.rs")).toBe("rust");
  });

  test("maps .js to javascript", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
  });

  test("returns null for unsupported extensions", () => {
    expect(detectLanguage("style.css")).toBeNull();
    expect(detectLanguage("data.json")).toBeNull();
    expect(detectLanguage("README.md")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseSource", () => {
  test("parses TypeScript and returns a tree", async () => {
    const code = `export function hello(): string { return "hi"; }`;
    const tree = await parseSource(code, "typescript");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("program");
    tree!.delete();
  });

  test("parses Python and returns a tree", async () => {
    const code = `def greet(name):\n    return f"Hello {name}"`;
    const tree = await parseSource(code, "python");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("module");
    tree!.delete();
  });

  test("parses Go and returns a tree", async () => {
    const code = `package main\n\nfunc Hello() string { return "hi" }`;
    const tree = await parseSource(code, "go");
    expect(tree).not.toBeNull();
    tree!.delete();
  });

  test("parses Rust and returns a tree", async () => {
    const code = `pub fn hello() -> &'static str { "hi" }`;
    const tree = await parseSource(code, "rust");
    expect(tree).not.toBeNull();
    tree!.delete();
  });

  test("returns null for unsupported language", async () => {
    const tree = await parseSource("some content", "nonexistent-language");
    expect(tree).toBeNull();
  });

  test("parses empty string without error", async () => {
    const tree = await parseSource("", "typescript");
    expect(tree).not.toBeNull();
    tree!.delete();
  });
});

describe("parseFile", () => {
  test("detects language from extension and parses", async () => {
    const tree = await parseFile("src/main.py", "def foo(): pass");
    expect(tree).not.toBeNull();
    tree!.delete();
  });

  test("returns null for unsupported file type", async () => {
    const tree = await parseFile("style.css", "body {}");
    expect(tree).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction: TypeScript
// ---------------------------------------------------------------------------

describe("extractSymbols - TypeScript", () => {
  test("extracts exported function declaration", async () => {
    const code = `export function createUser(name: string): User { return { name }; }`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "createUser");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("function");
    expect(sym!.exported).toBe(true);
    expect(sym!.line).toBe(1);
  });

  test("extracts non-exported function", async () => {
    const code = `function helper() { return 1; }`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "helper");
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });

  test("extracts arrow function as function", async () => {
    const code = `export const handler = () => { return "ok"; };`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "handler");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("function");
    expect(sym!.exported).toBe(true);
  });

  test("extracts class with methods", async () => {
    const code = [
      "export class UserService {",
      "  getUser(id: string) { return null; }",
      "  deleteUser(id: string) { }",
      "}",
    ].join("\n");
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const cls = findSymbol(symbols, "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.exported).toBe(true);

    expect(findSymbol(symbols, "getUser")).toBeDefined();
    expect(findSymbol(symbols, "getUser")!.kind).toBe("method");
    expect(findSymbol(symbols, "deleteUser")).toBeDefined();
  });

  test("extracts interface", async () => {
    const code = `export interface Task { id: string; title: string; }`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "Task");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("interface");
    expect(sym!.exported).toBe(true);
  });

  test("extracts type alias", async () => {
    const code = `export type Status = "pending" | "done";`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "Status");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("type");
  });

  test("extracts enum", async () => {
    const code = `export enum Color { Red, Green, Blue }`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "Color");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("enum");
  });

  test("extracts const as const kind", async () => {
    const code = `export const MAX_RETRIES = 3;`;
    const tree = await parseSource(code, "typescript");
    const symbols = extractSymbols(tree!.rootNode, "typescript");
    tree!.delete();

    const sym = findSymbol(symbols, "MAX_RETRIES");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("const");
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction: Python
// ---------------------------------------------------------------------------

describe("extractSymbols - Python", () => {
  test("extracts top-level function", async () => {
    const code = `def process_data(items):\n    return [x * 2 for x in items]`;
    const tree = await parseSource(code, "python");
    const symbols = extractSymbols(tree!.rootNode, "python");
    tree!.delete();

    const sym = findSymbol(symbols, "process_data");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("function");
    expect(sym!.exported).toBe(true);
  });

  test("skips private functions (underscore prefix)", async () => {
    const code = `def _internal_helper():\n    pass`;
    const tree = await parseSource(code, "python");
    const symbols = extractSymbols(tree!.rootNode, "python");
    tree!.delete();

    expect(findSymbol(symbols, "_internal_helper")).toBeUndefined();
  });

  test("extracts class with methods", async () => {
    const code = [
      "class UserManager:",
      "    def create_user(self, name):",
      "        pass",
      "    def _validate(self):",
      "        pass",
    ].join("\n");
    const tree = await parseSource(code, "python");
    const symbols = extractSymbols(tree!.rootNode, "python");
    tree!.delete();

    expect(findSymbol(symbols, "UserManager")).toBeDefined();
    expect(findSymbol(symbols, "UserManager")!.kind).toBe("class");
    expect(findSymbol(symbols, "create_user")).toBeDefined();
    expect(findSymbol(symbols, "create_user")!.kind).toBe("method");
    // Private method skipped
    expect(findSymbol(symbols, "_validate")).toBeUndefined();
  });

  test("extracts decorated function", async () => {
    const code = [
      "@app.route('/hello')",
      "def hello():",
      "    return 'world'",
    ].join("\n");
    const tree = await parseSource(code, "python");
    const symbols = extractSymbols(tree!.rootNode, "python");
    tree!.delete();

    expect(findSymbol(symbols, "hello")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction: Go
// ---------------------------------------------------------------------------

describe("extractSymbols - Go", () => {
  test("extracts exported function (capitalized)", async () => {
    const code = `package main\n\nfunc HandleRequest(w http.ResponseWriter, r *http.Request) {}`;
    const tree = await parseSource(code, "go");
    const symbols = extractSymbols(tree!.rootNode, "go");
    tree!.delete();

    const sym = findSymbol(symbols, "HandleRequest");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("function");
    expect(sym!.exported).toBe(true);
  });

  test("marks unexported function (lowercase)", async () => {
    const code = `package main\n\nfunc helperFunc() int { return 0 }`;
    const tree = await parseSource(code, "go");
    const symbols = extractSymbols(tree!.rootNode, "go");
    tree!.delete();

    const sym = findSymbol(symbols, "helperFunc");
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });

  test("extracts struct type", async () => {
    const code = `package main\n\ntype User struct {\n\tName string\n\tAge int\n}`;
    const tree = await parseSource(code, "go");
    const symbols = extractSymbols(tree!.rootNode, "go");
    tree!.delete();

    const sym = findSymbol(symbols, "User");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("struct");
    expect(sym!.exported).toBe(true);
  });

  test("extracts interface type", async () => {
    const code = `package main\n\ntype Reader interface {\n\tRead(p []byte) (n int, err error)\n}`;
    const tree = await parseSource(code, "go");
    const symbols = extractSymbols(tree!.rootNode, "go");
    tree!.delete();

    const sym = findSymbol(symbols, "Reader");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("interface");
  });

  test("extracts method declaration", async () => {
    const code = `package main\n\nfunc (u *User) GetName() string { return u.Name }`;
    const tree = await parseSource(code, "go");
    const symbols = extractSymbols(tree!.rootNode, "go");
    tree!.delete();

    const sym = findSymbol(symbols, "GetName");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("method");
    expect(sym!.exported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction: Rust
// ---------------------------------------------------------------------------

describe("extractSymbols - Rust", () => {
  test("extracts pub function", async () => {
    const code = `pub fn serve(port: u16) -> Result<(), Error> { Ok(()) }`;
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const sym = findSymbol(symbols, "serve");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("function");
    expect(sym!.exported).toBe(true);
  });

  test("marks non-pub function as not exported", async () => {
    const code = `fn internal_helper() -> i32 { 42 }`;
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const sym = findSymbol(symbols, "internal_helper");
    expect(sym).toBeDefined();
    expect(sym!.exported).toBe(false);
  });

  test("extracts struct", async () => {
    const code = `pub struct Config {\n    pub port: u16,\n    pub host: String,\n}`;
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const sym = findSymbol(symbols, "Config");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("struct");
    expect(sym!.exported).toBe(true);
  });

  test("extracts enum", async () => {
    const code = `pub enum Status { Active, Inactive, Suspended }`;
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const sym = findSymbol(symbols, "Status");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("enum");
  });

  test("extracts trait", async () => {
    const code = `pub trait Serializable { fn serialize(&self) -> String; }`;
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const sym = findSymbol(symbols, "Serializable");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("trait");
  });

  test("extracts impl methods", async () => {
    const code = [
      "struct Server;",
      "impl Server {",
      "    pub fn start(&self) {}",
      "    fn stop(&self) {}",
      "}",
    ].join("\n");
    const tree = await parseSource(code, "rust");
    const symbols = extractSymbols(tree!.rootNode, "rust");
    tree!.delete();

    const start = findSymbol(symbols, "start");
    expect(start).toBeDefined();
    expect(start!.kind).toBe("method");
    expect(start!.exported).toBe(true);

    const stop = findSymbol(symbols, "stop");
    expect(stop).toBeDefined();
    expect(stop!.exported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

describe("extractReferences", () => {
  test("extracts identifier references from TypeScript", async () => {
    const code = [
      'import { UserService } from "./service";',
      "const result = UserService.getUser(userId);",
      "console.log(result);",
    ].join("\n");
    const tree = await parseSource(code, "typescript");
    const refs = extractReferences(tree!.rootNode);
    tree!.delete();

    expect(refs.has("UserService")).toBe(true);
    expect(refs.has("getUser")).toBe(true);
    expect(refs.has("result")).toBe(true);
    expect(refs.has("console")).toBe(true);
  });

  test("filters out short identifiers", async () => {
    const code = `const x = 1;\nconst ab = 2;\nconst abc = 3;`;
    const tree = await parseSource(code, "typescript");
    const refs = extractReferences(tree!.rootNode);
    tree!.delete();

    // x (1 char) and ab (2 chars) should be filtered
    expect(refs.has("x")).toBe(false);
    expect(refs.has("ab")).toBe(false);
    // abc (3 chars) should be included
    expect(refs.has("abc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repo map (integration with git)
// ---------------------------------------------------------------------------

describe("buildRepoMap", () => {
  const tmpDir = join("/tmp", `hoto-treesitter-test-${ulid()}`);

  beforeAll(async () => {
    // Create a temp git repo with source files
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    // File A: defines functions that B references
    writeFileSync(
      join(tmpDir, "src/types.ts"),
      [
        "export interface User { id: string; name: string; }",
        "export interface Task { id: string; title: string; }",
        "export type Status = 'pending' | 'done';",
      ].join("\n"),
    );

    // File B: references types from A
    writeFileSync(
      join(tmpDir, "src/service.ts"),
      [
        'import type { User, Task } from "./types";',
        "",
        "export function createUser(name: string): User {",
        '  return { id: "1", name };',
        "}",
        "",
        "export function listTasks(): Task[] {",
        "  return [];",
        "}",
        "",
        "function internalHelper(): void {}",
      ].join("\n"),
    );

    // File C: references service
    writeFileSync(
      join(tmpDir, "src/handler.ts"),
      [
        'import { createUser, listTasks } from "./service";',
        "",
        "export async function handleRequest(req: Request): Promise<Response> {",
        '  const user = createUser("test");',
        "  const tasks = listTasks();",
        '  return new Response("ok");',
        "}",
      ].join("\n"),
    );

    // Python file
    writeFileSync(
      join(tmpDir, "src/utils.py"),
      [
        "def process_items(items):",
        "    return [x * 2 for x in items]",
        "",
        "class DataProcessor:",
        "    def run(self):",
        "        pass",
      ].join("\n"),
    );

    // Initialize git repo
    await $`git -C ${tmpDir} init`.quiet();
    await $`git -C ${tmpDir} add -A`.quiet();
    await $`git -C ${tmpDir} -c user.email=test@test.com -c user.name=Test commit -m "init"`.quiet();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("produces output containing expected symbols", async () => {
    const map = await buildRepoMap({ repoPath: tmpDir });
    expect(map).toContain("User");
    expect(map).toContain("Task");
    expect(map).toContain("createUser");
    expect(map).toContain("handleRequest");
    expect(map).toContain("process_items");
    expect(map).toContain("DataProcessor");
  });

  test("marks exported symbols with +", async () => {
    const map = await buildRepoMap({ repoPath: tmpDir });
    expect(map).toContain("+interface User");
    expect(map).toContain("+function createUser");
  });

  test("includes non-exported symbols without +", async () => {
    const map = await buildRepoMap({ repoPath: tmpDir });
    expect(map).toContain("function internalHelper");
    // Should not have + prefix
    expect(map).not.toContain("+function internalHelper");
  });

  test("respects token budget", async () => {
    const map = await buildRepoMap({ repoPath: tmpDir, maxTokens: 50 });
    // 50 tokens * 4 chars = 200 chars max
    expect(map.length).toBeLessThanOrEqual(200);
  });

  test("returns empty string for non-git directory", async () => {
    const nonGit = join("/tmp", `hoto-treesitter-nogit-${ulid()}`);
    mkdirSync(nonGit, { recursive: true });
    writeFileSync(join(nonGit, "index.ts"), "export function foo() {}");
    const map = await buildRepoMap({ repoPath: nonGit });
    expect(map).toBe("");
    rmSync(nonGit, { recursive: true, force: true });
  });

  test("returns empty string for repo with no source files", async () => {
    const emptyRepo = join("/tmp", `hoto-treesitter-empty-${ulid()}`);
    mkdirSync(emptyRepo, { recursive: true });
    writeFileSync(join(emptyRepo, "README.md"), "# Hello");
    await $`git -C ${emptyRepo} init`.quiet();
    await $`git -C ${emptyRepo} add -A`.quiet();
    await $`git -C ${emptyRepo} -c user.email=test@test.com -c user.name=Test commit -m "init"`.quiet();
    const map = await buildRepoMap({ repoPath: emptyRepo });
    expect(map).toBe("");
    rmSync(emptyRepo, { recursive: true, force: true });
  });

  test("files referenced more are ranked higher", async () => {
    const map = await buildRepoMap({ repoPath: tmpDir, maxTokens: 5000 });
    const lines = map.split("\n");

    // types.ts defines symbols referenced by both service.ts and handler.ts
    // so it should appear before utils.py (which has no references to/from others)
    const typesIndex = lines.findIndex((l) => l.includes("types.ts"));
    const utilsIndex = lines.findIndex((l) => l.includes("utils.py"));

    expect(typesIndex).toBeGreaterThanOrEqual(0);
    expect(utilsIndex).toBeGreaterThanOrEqual(0);
    expect(typesIndex).toBeLessThan(utilsIndex);
  });
});

// ---------------------------------------------------------------------------
// Indexer integration
// ---------------------------------------------------------------------------

describe("indexer integration", () => {
  const tmpDir = join("/tmp", `hoto-indexer-treesitter-${ulid()}`);
  const workspaceDir = join(tmpDir, "workspace");
  const repoDir = join(tmpDir, "repo");

  beforeAll(async () => {
    // Set workspace to isolated dir before importing DB modules
    process.env.HOTO_WORKSPACE = workspaceDir;
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(repoDir, "src"), { recursive: true });

    writeFileSync(
      join(repoDir, "src/index.ts"),
      [
        "export function main() { console.log('hello'); }",
        "export interface AppConfig { port: number; }",
      ].join("\n"),
    );

    await $`git -C ${repoDir} init`.quiet();
    await $`git -C ${repoDir} add -A`.quiet();
    await $`git -C ${repoDir} -c user.email=test@test.com -c user.name=Test commit -m "init"`.quiet();
  });

  afterAll(() => {
    try {
      const { closeDb } = require("../src/knowledge/db");
      closeDb();
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("indexRepo creates code_symbols chunk", async () => {
    // Close any existing DB singleton and reopen.
    // config.dbPath is immutable (set at import time), so ensure its parent dir exists.
    const { config } = await import("../src/shared/config");
    mkdirSync(config.workspaceDir, { recursive: true });
    const dbModule = await import("../src/knowledge/db");
    dbModule.closeDb();
    const db = dbModule.getDb();

    // Create a repo entry (use INSERT OR IGNORE in case prior test run left data)
    const repoName = `test-repo-ts-${Date.now()}`;
    db.run(
      "INSERT INTO repos (name, path, description) VALUES (?, ?, ?)",
      [repoName, repoDir, "Test repository"],
    );
    const repo = db.query("SELECT * FROM repos WHERE name = ?").get(repoName) as {
      id: number;
      name: string;
      path: string;
      description: string;
      build_cmd: string | null;
      test_cmd: string | null;
      run_cmd: string | null;
      lint_cmd: string | null;
      language: string | null;
      framework: string | null;
      docker_compose_path: string | null;
      metadata: string | null;
    };

    // Run indexer (mock chromadb to avoid needing the service)
    const { indexRepo } = await import("../src/knowledge/indexer");

    // indexRepo will fail on chromadb but should still insert SQLite chunks
    try {
      await indexRepo(repo as any);
    } catch {
      // ChromaDB failure is expected in test env
    }

    // Check for code_symbols chunk
    const symbolChunk = db.query(
      "SELECT * FROM knowledge_chunks WHERE repo_id = ? AND chunk_type = 'code_symbols'",
    ).get(repo.id) as { content: string; title: string } | null;

    expect(symbolChunk).not.toBeNull();
    expect(symbolChunk!.title).toContain("Code Structure Map");
    expect(symbolChunk!.content).toContain("main");
    expect(symbolChunk!.content).toContain("AppConfig");
  });
});
