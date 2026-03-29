import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../shared/logger";

export interface RepoMetadata {
  language: string | null;
  framework: string | null;
  build_cmd: string | null;
  test_cmd: string | null;
  run_cmd: string | null;
  lint_cmd: string | null;
  description: string | null;
  docker_compose_path: string | null;
  docker_image: string | null;
}

const LANGUAGE_DOCKER_IMAGES: Record<string, string> = {
  "typescript/bun": "oven/bun:latest",
  "typescript": "node:22-slim",
  "javascript": "node:22-slim",
  "python": "python:3.12-slim",
  "go": "golang:1.23-slim",
  "rust": "rust:1.83-slim",
  "java": "eclipse-temurin:21-jdk-slim",
};

export async function parseRepo(repoPath: string): Promise<RepoMetadata> {
  const meta: RepoMetadata = {
    language: null,
    framework: null,
    build_cmd: null,
    test_cmd: null,
    run_cmd: null,
    lint_cmd: null,
    description: null,
    docker_compose_path: null,
    docker_image: null,
  };

  // Check for package.json (Node/Bun/Deno)
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      meta.description = pkg.description ?? null;

      const scripts = pkg.scripts ?? {};
      meta.build_cmd = scripts.build ?? null;
      meta.test_cmd = scripts.test ?? null;
      meta.run_cmd = scripts.start ?? scripts.dev ?? null;
      meta.lint_cmd = scripts.lint ?? null;

      // Detect framework
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) meta.framework = "next";
      else if (deps.nuxt) meta.framework = "nuxt";
      else if (deps.react) meta.framework = "react";
      else if (deps.vue) meta.framework = "vue";
      else if (deps.svelte) meta.framework = "svelte";
      else if (deps.hono) meta.framework = "hono";
      else if (deps.express) meta.framework = "express";
      else if (deps.fastify) meta.framework = "fastify";

      // Detect runtime
      if (existsSync(join(repoPath, "bunfig.toml")) || existsSync(join(repoPath, "bun.lockb"))) {
        meta.language = "typescript/bun";
      } else if (deps.typescript || existsSync(join(repoPath, "tsconfig.json"))) {
        meta.language = "typescript";
      } else {
        meta.language = "javascript";
      }
    } catch (err) {
      logger.warn("Failed to parse package.json", { path: pkgPath, error: String(err) });
    }
  }

  // Check for pyproject.toml / setup.py (Python)
  if (existsSync(join(repoPath, "pyproject.toml"))) {
    meta.language = "python";
    try {
      const content = await readFile(join(repoPath, "pyproject.toml"), "utf-8");
      if (content.includes("[tool.pytest")) meta.test_cmd = "pytest";
      if (content.includes("ruff")) meta.lint_cmd = "ruff check .";
      else if (content.includes("flake8")) meta.lint_cmd = "flake8 .";
      if (content.includes("django")) meta.framework = "django";
      else if (content.includes("fastapi")) meta.framework = "fastapi";
      else if (content.includes("flask")) meta.framework = "flask";
    } catch {}
  } else if (existsSync(join(repoPath, "setup.py"))) {
    meta.language = "python";
    meta.test_cmd = "pytest";
  }

  // Check for go.mod (Go)
  if (existsSync(join(repoPath, "go.mod"))) {
    meta.language = "go";
    meta.build_cmd = "go build ./...";
    meta.test_cmd = "go test ./...";
    meta.lint_cmd = "golangci-lint run";
  }

  // Check for Cargo.toml (Rust)
  if (existsSync(join(repoPath, "Cargo.toml"))) {
    meta.language = "rust";
    meta.build_cmd = "cargo build";
    meta.test_cmd = "cargo test";
    meta.lint_cmd = "cargo clippy";
  }

  // Check for Makefile
  if (!meta.build_cmd && existsSync(join(repoPath, "Makefile"))) {
    try {
      const makefile = await readFile(join(repoPath, "Makefile"), "utf-8");
      if (makefile.includes("build:")) meta.build_cmd = "make build";
      if (makefile.includes("test:")) meta.test_cmd = meta.test_cmd ?? "make test";
      if (makefile.includes("lint:")) meta.lint_cmd = meta.lint_cmd ?? "make lint";
    } catch {}
  }

  // Check for docker-compose (prefer test-specific compose files)
  for (const name of [
    "docker-compose.test.yml", "docker-compose.test.yaml",
    "docker-compose.yml", "docker-compose.yaml",
    "compose.yml", "compose.yaml",
  ]) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      meta.docker_compose_path = p;
      break;
    }
  }

  // Check for pom.xml (Java/Maven)
  if (existsSync(join(repoPath, "pom.xml"))) {
    meta.language = meta.language ?? "java";
    meta.build_cmd = meta.build_cmd ?? "mvn compile";
    meta.test_cmd = meta.test_cmd ?? "mvn test";
    meta.lint_cmd = meta.lint_cmd ?? "mvn checkstyle:check";
  }

  // Resolve Docker image from language (only when no compose/Dockerfile)
  if (!meta.docker_compose_path && !existsSync(join(repoPath, "Dockerfile"))) {
    meta.docker_image = (meta.language && LANGUAGE_DOCKER_IMAGES[meta.language]) ?? null;
  }

  return meta;
}
