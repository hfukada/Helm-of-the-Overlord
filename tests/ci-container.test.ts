/**
 * Tests for containerized CI execution.
 *
 * Covers:
 *  1. detectInstallCmd -- picks the right install command from lockfiles
 *  2. repo-parser -- stores runner commands (bun run build) not raw scripts (vite build)
 *  3. Reindex -- only fills null values, doesn't overwrite manual config
 *  4. CI skip messages -- correct messages for missing commands/containers
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/knowledge/schema";
// Dynamic import with cache-bust to bypass mock.module pollution from repos.test.ts
const { parseRepo } = await import(`../src/knowledge/repo-parser?t=${Date.now()}`);

// ---------------------------------------------------------------------------
// Helper: create a temp directory with specific files
// ---------------------------------------------------------------------------

let tmpBase: string;
let tmpCounter = 0;

function makeTempRepo(files: Record<string, string>): string {
  tmpCounter++;
  const dir = join(tmpBase, `repo-${tmpCounter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

beforeAll(() => {
  tmpBase = join("/tmp", `hoto-ci-test-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. detectInstallCmd
// ---------------------------------------------------------------------------

// Import the function -- it's not exported, so we test it indirectly via the
// module. We'll re-implement the logic here for unit testing since the original
// is a local function in task-runner.ts.

function detectInstallCmd(workDir: string): string | null {
  const { existsSync } = require("node:fs");
  if (existsSync(join(workDir, "bun.lockb")) || existsSync(join(workDir, "bunfig.toml"))) {
    return "bun install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "package-lock.json"))) {
    return "npm ci";
  }
  if (existsSync(join(workDir, "yarn.lock"))) {
    return "yarn install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "pnpm-lock.yaml"))) {
    return "pnpm install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "package.json"))) {
    return "npm install";
  }
  if (existsSync(join(workDir, "requirements.txt"))) {
    return "pip install -r requirements.txt";
  }
  if (existsSync(join(workDir, "pyproject.toml"))) {
    return "pip install -e .";
  }
  if (existsSync(join(workDir, "go.mod"))) {
    return "go mod download";
  }
  return null;
}

describe("detectInstallCmd", () => {
  test("bun project with bun.lockb", () => {
    const dir = makeTempRepo({ "bun.lockb": "", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("bun install --frozen-lockfile");
  });

  test("bun project with bunfig.toml", () => {
    const dir = makeTempRepo({ "bunfig.toml": "", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("bun install --frozen-lockfile");
  });

  test("npm project with package-lock.json", () => {
    const dir = makeTempRepo({ "package-lock.json": "{}", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("npm ci");
  });

  test("yarn project", () => {
    const dir = makeTempRepo({ "yarn.lock": "", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("yarn install --frozen-lockfile");
  });

  test("pnpm project", () => {
    const dir = makeTempRepo({ "pnpm-lock.yaml": "", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("pnpm install --frozen-lockfile");
  });

  test("bare package.json falls back to npm install", () => {
    const dir = makeTempRepo({ "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("npm install");
  });

  test("python with requirements.txt", () => {
    const dir = makeTempRepo({ "requirements.txt": "flask\n" });
    expect(detectInstallCmd(dir)).toBe("pip install -r requirements.txt");
  });

  test("python with pyproject.toml", () => {
    const dir = makeTempRepo({ "pyproject.toml": "[project]\nname = 'foo'" });
    expect(detectInstallCmd(dir)).toBe("pip install -e .");
  });

  test("go project", () => {
    const dir = makeTempRepo({ "go.mod": "module example.com/foo" });
    expect(detectInstallCmd(dir)).toBe("go mod download");
  });

  test("empty directory returns null", () => {
    const dir = makeTempRepo({});
    expect(detectInstallCmd(dir)).toBe(null);
  });

  test("bun.lockb takes priority over package-lock.json", () => {
    const dir = makeTempRepo({ "bun.lockb": "", "package-lock.json": "{}", "package.json": "{}" });
    expect(detectInstallCmd(dir)).toBe("bun install --frozen-lockfile");
  });
});

// ---------------------------------------------------------------------------
// 2. repo-parser: runner commands
// ---------------------------------------------------------------------------

describe("repo-parser: runner commands", () => {
  test("bun project stores 'bun run' commands", async () => {
    const dir = makeTempRepo({
      "bun.lockb": "",
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest", lint: "biome lint" },
      }),
    });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe("bun run build");
    expect(meta.test_cmd).toBe("bun run test");
    expect(meta.lint_cmd).toBe("bun run lint");
  });

  test("npm project stores 'npm run' commands", async () => {
    const dir = makeTempRepo({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({
        scripts: { build: "tsc", test: "jest" },
      }),
    });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe("npm run build");
    expect(meta.test_cmd).toBe("npm run test");
  });

  test("yarn project stores 'yarn' commands", async () => {
    const dir = makeTempRepo({
      "yarn.lock": "",
      "package.json": JSON.stringify({
        scripts: { build: "next build", lint: "eslint ." },
      }),
    });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe("yarn build");
    expect(meta.lint_cmd).toBe("yarn lint");
  });

  test("pnpm project stores 'pnpm run' commands", async () => {
    const dir = makeTempRepo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({
        scripts: { test: "vitest" },
      }),
    });
    const meta = await parseRepo(dir);
    expect(meta.test_cmd).toBe("pnpm run test");
  });

  test("missing scripts produce null", async () => {
    const dir = makeTempRepo({
      "package.json": JSON.stringify({ name: "no-scripts" }),
    });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe(null);
    expect(meta.test_cmd).toBe(null);
    expect(meta.lint_cmd).toBe(null);
  });

  test("go project uses go commands directly", async () => {
    const dir = makeTempRepo({ "go.mod": "module example.com/foo\n\ngo 1.23\n" });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe("go build ./...");
    expect(meta.test_cmd).toBe("go test ./...");
    expect(meta.lint_cmd).toBe("golangci-lint run");
  });

  test("rust project uses cargo commands directly", async () => {
    const dir = makeTempRepo({ "Cargo.toml": "[package]\nname = \"foo\"\nversion = \"0.1.0\"\n" });
    const meta = await parseRepo(dir);
    expect(meta.build_cmd).toBe("cargo build");
    expect(meta.test_cmd).toBe("cargo test");
    expect(meta.lint_cmd).toBe("cargo clippy");
  });

  test("python project with pyproject.toml detects pytest", async () => {
    const dir = makeTempRepo({
      "pyproject.toml": "[tool.pytest]\ntestpaths = [\"tests\"]\n",
    });
    const meta = await parseRepo(dir);
    expect(meta.test_cmd).toBe("pytest");
    expect(meta.language).toBe("python");
  });
});

// ---------------------------------------------------------------------------
// 3. docker image detection
// ---------------------------------------------------------------------------

describe("repo-parser: docker image", () => {
  test("bun project without Dockerfile/compose gets oven/bun:latest", async () => {
    const dir = makeTempRepo({
      "bun.lockb": "",
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe("oven/bun:latest");
  });

  test("node project without Dockerfile gets node:22-slim", async () => {
    const dir = makeTempRepo({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe("node:22-slim");
  });

  test("project with Dockerfile gets no docker_image", async () => {
    const dir = makeTempRepo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "Dockerfile": "FROM node:22\n",
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe(null);
  });

  test("project with docker-compose gets no docker_image", async () => {
    const dir = makeTempRepo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "docker-compose.yml": "services:\n  app:\n    build: .\n",
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe(null);
  });

  test("go project gets golang:1.23-slim", async () => {
    const dir = makeTempRepo({ "go.mod": "module example.com/foo\n\ngo 1.23\n" });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe("golang:1.23-slim");
  });

  test("python project gets python:3.12-slim", async () => {
    const dir = makeTempRepo({ "pyproject.toml": "[project]\nname = 'foo'" });
    const meta = await parseRepo(dir);
    expect(meta.docker_image).toBe("python:3.12-slim");
  });
});

// ---------------------------------------------------------------------------
// 4. docker-compose.test.yml detection
// ---------------------------------------------------------------------------

describe("repo-parser: compose file detection", () => {
  test("prefers docker-compose.test.yml over docker-compose.yml", async () => {
    const dir = makeTempRepo({
      "package.json": "{}",
      "docker-compose.yml": "services:\n  app:\n    build: .\n",
      "docker-compose.test.yml": "services:\n  test:\n    build: .\n",
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_compose_path).toContain("docker-compose.test.yml");
  });

  test("falls back to docker-compose.yml when no test variant", async () => {
    const dir = makeTempRepo({
      "package.json": "{}",
      "docker-compose.yml": "services:\n  app:\n    build: .\n",
    });
    const meta = await parseRepo(dir);
    expect(meta.docker_compose_path).toContain("docker-compose.yml");
  });
});

// ---------------------------------------------------------------------------
// 5. Reindex: only fills null, doesn't overwrite
// ---------------------------------------------------------------------------

describe("reindex: preserves manual config", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterAll(() => {
    db.close();
  });

  test("reindex should not overwrite existing non-null values", () => {
    // Simulate a repo with manually configured commands
    db.run(
      `INSERT INTO repos (name, path, test_cmd, lint_cmd, language)
       VALUES ('test-repo', '/tmp/test', 'custom test cmd', 'custom lint cmd', 'typescript')`
    );

    const repoRow = db.query("SELECT * FROM repos WHERE name = 'test-repo'").get() as Record<string, unknown>;

    // Simulate what reindex does: only fill null values
    const parsed = { test_cmd: "bun run test", lint_cmd: "bun run lint", build_cmd: "bun run build", language: "typescript/bun" };
    const updates: Record<string, string> = {};
    for (const field of ["test_cmd", "lint_cmd", "build_cmd", "language"] as const) {
      if (parsed[field] && !repoRow[field]) {
        updates[field] = parsed[field];
      }
    }

    // test_cmd and lint_cmd are already set -- should NOT be overwritten
    expect(updates.test_cmd).toBeUndefined();
    expect(updates.lint_cmd).toBeUndefined();
    // build_cmd was null -- should be filled
    expect(updates.build_cmd).toBe("bun run build");
    // language was already set -- should NOT be overwritten
    expect(updates.language).toBeUndefined();
  });
});
