import { describe, test, expect, mock } from "bun:test";

// Mock the search module before importing context-builder
mock.module("../src/knowledge/search", () => ({
  search: async () => [],
}));

// Mock the logger to avoid side effects
mock.module("../src/shared/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import {
  buildPlanPrompt,
  buildImplementPrompt,
  buildSystemPrompt,
} from "../src/orchestrator/context-builder";
import type { Task, Repo } from "../src/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "test-task-id",
    title: "Add user authentication",
    description: "Implement JWT-based auth with login and signup endpoints",
    repo_id: 1,
    status: "pending",
    blueprint_state: null,
    branch_name: null,
    source: "cli",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRepo(overrides?: Partial<Repo>): Repo {
  return {
    id: 1,
    name: "my-app",
    path: "/home/user/my-app",
    description: "A web application",
    build_cmd: "bun run build",
    test_cmd: "bun test",
    run_cmd: null,
    lint_cmd: "bun run lint",
    language: "TypeScript",
    framework: "Hono",
    docker_compose_path: null,
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPlanPrompt
// ---------------------------------------------------------------------------

describe("buildPlanPrompt", () => {
  test("includes task title and description", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Implement JWT-based auth");
  });

  test("includes repo metadata", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("Repository: my-app");
    expect(prompt).toContain("Language: TypeScript");
    expect(prompt).toContain("Framework: Hono");
    expect(prompt).toContain("Build command: bun run build");
    expect(prompt).toContain("Test command: bun test");
    expect(prompt).toContain("Lint command: bun run lint");
  });

  test("omits missing repo fields", async () => {
    const prompt = await buildPlanPrompt(
      makeTask(),
      makeRepo({ language: null, framework: null, build_cmd: null })
    );
    expect(prompt).not.toContain("Language:");
    expect(prompt).not.toContain("Framework:");
    expect(prompt).not.toContain("Build command:");
  });

  test("requires structured output format with Summary, Files, Execution Plan", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("### Summary");
    expect(prompt).toContain("### Files to Modify");
    expect(prompt).toContain("### Execution Plan");
  });

  test("requires numbered checklist with actionable steps", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("numbered checklist");
    expect(prompt).toContain("actionable unit of work");
  });

  test("requires lint and test as final checklist steps", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("- [ ] Run lint and verify no errors");
    expect(prompt).toContain("- [ ] Run tests and verify they pass");
  });

  test("lint/test steps come after execution plan section", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    const execPlanIdx = prompt.indexOf("### Execution Plan");
    const lintIdx = prompt.indexOf("- [ ] Run lint");
    const testIdx = prompt.indexOf("- [ ] Run tests");
    expect(execPlanIdx).toBeGreaterThan(-1);
    expect(lintIdx).toBeGreaterThan(execPlanIdx);
    expect(testIdx).toBeGreaterThan(lintIdx);
  });

  test("instructs not to implement", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("Do NOT implement the changes");
  });
});

// ---------------------------------------------------------------------------
// buildImplementPrompt
// ---------------------------------------------------------------------------

describe("buildImplementPrompt", () => {
  const samplePlan = [
    "### Summary",
    "Add JWT auth to the API.",
    "",
    "### Files to Modify",
    "- src/auth.ts (new): JWT helper functions",
    "- src/routes/login.ts (new): Login endpoint",
    "",
    "### Execution Plan",
    "1. [ ] Create src/auth.ts with signToken and verifyToken functions",
    "2. [ ] Create src/routes/login.ts with POST /login handler",
    "3. [ ] Run lint and verify no errors",
    "4. [ ] Run tests and verify they pass",
  ].join("\n");

  test("includes the plan text", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("## Implementation Plan");
    expect(prompt).toContain(samplePlan);
  });

  test("instructs to follow execution plan step by step", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Follow the Execution Plan checklist above step by step");
  });

  test("instructs not to run lint/test commands", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Do NOT run lint or test commands yourself");
    expect(prompt).toContain("orchestrator handles that automatically");
  });

  test("instructs not to commit", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Do NOT commit changes");
  });

  test("includes task context", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Repository: my-app");
  });

  test("includes repo language and framework", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Language: TypeScript");
    expect(prompt).toContain("Framework: Hono");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  test("includes repo name", () => {
    const prompt = buildSystemPrompt(makeRepo());
    expect(prompt).toContain('working on the "my-app" repository');
  });

  test("default: lists available tools", () => {
    const prompt = buildSystemPrompt(makeRepo());
    expect(prompt).toContain("Read, Write, Edit, Glob, Grep, and Bash");
  });

  test("with MCP: prefers knowledge base tools", () => {
    const prompt = buildSystemPrompt(makeRepo(), { hasMcp: true });
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("list_files");
    expect(prompt).toContain("read_file");
  });

  test("with Docker: warns not to run build/test commands", () => {
    const prompt = buildSystemPrompt(makeRepo(), { hasDocker: true });
    expect(prompt).toContain("Do NOT run build, test, lint");
  });

  test("with docker_compose_path: detects Docker automatically", () => {
    const prompt = buildSystemPrompt(makeRepo({ docker_compose_path: "docker-compose.yml" }));
    expect(prompt).toContain("Do NOT run build, test, lint");
  });

  test("always includes safety instructions", () => {
    const prompt = buildSystemPrompt(makeRepo());
    expect(prompt).toContain("Do not run destructive commands");
    expect(prompt).toContain("Do not push to git");
  });
});
