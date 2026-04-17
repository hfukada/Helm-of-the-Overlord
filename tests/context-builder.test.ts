import { describe, test, expect, mock } from "bun:test";

// Mock the DB module before importing context-builder (needed for getRelationshipContext and buildRevisionPlanPrompt)
mock.module("../src/knowledge/db", () => ({
  getDb: () => ({
    query: () => ({ all: () => [], get: () => null }),
  }),
}));

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
  buildRevisionPlanPrompt,
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
    use_full_copy: false,
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
    extra_context: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPlanPrompt
// ---------------------------------------------------------------------------

describe("buildPlanPrompt", () => {
  test("includes task description", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("Implement JWT-based auth");
  });

  test("includes repo name in repo list", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("my-app");
  });

  test("includes repo metadata in repo list", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("Hono");
    expect(prompt).toContain("lint: `bun run lint`");
    expect(prompt).toContain("test: `bun test`");
  });

  test("omits missing repo fields", async () => {
    const prompt = await buildPlanPrompt(
      makeTask(),
      makeRepo({ language: null, framework: null, lint_cmd: null })
    );
    expect(prompt).not.toContain("TypeScript");
    expect(prompt).not.toContain("Hono");
    expect(prompt).not.toContain("lint:");
  });

  test("includes output format with Summary and Execution Plan", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("### Summary");
    expect(prompt).toContain("### Execution Plan");
  });

  test("instructs not to implement", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("Do NOT implement");
  });

  test("accepts array of repos", async () => {
    const repos = [
      makeRepo({ name: "api", language: "TypeScript" }),
      makeRepo({ name: "frontend", language: "JavaScript", framework: "React" }),
    ];
    const prompt = await buildPlanPrompt(makeTask(), repos);
    expect(prompt).toContain("api");
    expect(prompt).toContain("frontend");
    expect(prompt).toContain("React");
  });

  test("includes multi-repo prefix instruction", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo());
    expect(prompt).toContain("[repo-name]");
  });

  test("appends extra_context to knowledge context when set", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo({ extra_context: "always update the API too" }));
    expect(prompt).toContain("## Extra Repository Context");
    expect(prompt).toContain("always update the API too");
  });

  test("omits Extra Repository Context section when extra_context is null", async () => {
    const prompt = await buildPlanPrompt(makeTask(), makeRepo({ extra_context: null }));
    expect(prompt).not.toContain("## Extra Repository Context");
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
    "### Execution Plan",
    "1. [ ] Create src/auth.ts with signToken and verifyToken functions",
    "2. [ ] Create src/routes/login.ts with POST /login handler",
  ].join("\n");

  test("includes the plan text", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("## Plan");
    expect(prompt).toContain(samplePlan);
  });

  test("instructs to follow plan step by step", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Follow the Execution Plan step by step");
  });

  test("instructs not to run lint/test commands", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Do NOT run lint, test, or build");
  });

  test("instructs not to commit", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Do NOT commit");
  });

  test("includes task description", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("Implement JWT-based auth");
  });

  test("includes repo in repo list", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo(), samplePlan);
    expect(prompt).toContain("my-app");
    expect(prompt).toContain("TypeScript");
  });

  test("accepts array of repos", async () => {
    const repos = [makeRepo({ name: "api" }), makeRepo({ name: "web" })];
    const prompt = await buildImplementPrompt(makeTask(), repos, samplePlan);
    expect(prompt).toContain("api");
    expect(prompt).toContain("web");
  });

  test("appends extra_context to knowledge context when set", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo({ extra_context: "always update the API too" }), samplePlan);
    expect(prompt).toContain("## Extra Repository Context");
    expect(prompt).toContain("always update the API too");
  });

  test("omits Extra Repository Context section when extra_context is null", async () => {
    const prompt = await buildImplementPrompt(makeTask(), makeRepo({ extra_context: null }), samplePlan);
    expect(prompt).not.toContain("## Extra Repository Context");
  });
});

// ---------------------------------------------------------------------------
// buildRevisionPlanPrompt
// ---------------------------------------------------------------------------

describe("buildRevisionPlanPrompt", () => {
  test("appends extra_context to knowledge context when set", async () => {
    const prompt = await buildRevisionPlanPrompt(
      makeTask(),
      makeRepo({ extra_context: "CLI changes must also update API" }),
      "looks good",
      "## Plan\n..."
    );
    expect(prompt).toContain("## Extra Repository Context");
    expect(prompt).toContain("CLI changes must also update API");
  });

  test("omits Extra Repository Context section when extra_context is null", async () => {
    const prompt = await buildRevisionPlanPrompt(
      makeTask(),
      makeRepo({ extra_context: null }),
      "looks good",
      "## Plan\n..."
    );
    expect(prompt).not.toContain("## Extra Repository Context");
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

  test("with MCP: includes search_knowledge and directs to use it first", () => {
    const prompt = buildSystemPrompt(makeRepo(), { hasMcp: true });
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("Read, Glob, Grep");
    expect(prompt).toContain("START by calling search_knowledge");
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
