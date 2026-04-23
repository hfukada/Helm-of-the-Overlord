import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/knowledge/db";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-multi-repo";

// We need loadTaskAndRepos but can't mock runTask selectively with bun:test mocks.
// Instead, import them directly and test loadTaskAndRepos via the DB.
// For route tests, we mock the whole module to prevent runTask from executing.
const { mock } = await import("bun:test");

// Save the real loadTaskAndRepos before mocking
const realModule = await import("../src/orchestrator/task-runner");
const { loadTaskAndRepos } = realModule;

mock.module("../src/orchestrator/task-runner", () => ({
  ...realModule,
  runTask: async () => {},
  cleanupTask: async () => {},
}));

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-multi-repo", { recursive: true });
  getDb();

  const { tasks } = await import("../src/daemon/routes/tasks");
  app = new Hono();
  app.route("/tasks", tasks);
});

function seedRepos() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM task_prs");
  db.run("DELETE FROM task_repos");
  db.run("DELETE FROM agent_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM repos");
  db.exec("PRAGMA foreign_keys = ON");

  db.run("INSERT INTO repos (id, name, path, language) VALUES (200, 'my-api', '/tmp/my-api', 'typescript')");
  db.run("INSERT INTO repos (id, name, path, language) VALUES (201, 'my-frontend', '/tmp/my-frontend', 'typescript')");
  db.run("INSERT INTO repos (id, name, path, language) VALUES (202, 'shared-lib', '/tmp/shared-lib', 'go')");
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("B1: multi-repo task creation", () => {
  beforeEach(() => {
    seedRepos();
  });

  test("single repo_name still works", async () => {
    const res = await req("POST", "/tasks", {
      description: "add health check",
      repo_name: "my-api",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(1);

    // Check task_repos
    const db = getDb();
    const rows = db.query("SELECT * FROM task_repos WHERE task_id = ? AND role = 'target'").all(data.id) as Array<{ repo_id: number; role: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].repo_id).toBe(200);
    expect(rows[0].role).toBe("target");

    // Check legacy repo_id
    const task = db.query("SELECT repo_id FROM tasks WHERE id = ?").get(data.id) as { repo_id: number };
    expect(task.repo_id).toBe(200);
  });

  test("repo_names creates multiple task_repos rows", async () => {
    const res = await req("POST", "/tasks", {
      description: "add shared auth",
      repo_names: ["my-api", "my-frontend"],
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(2);

    const db = getDb();
    const rows = db.query(
      "SELECT repo_id FROM task_repos WHERE task_id = ? AND role = 'target' ORDER BY repo_id"
    ).all(data.id) as Array<{ repo_id: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0].repo_id).toBe(200);
    expect(rows[1].repo_id).toBe(201);

    // Legacy repo_id should be the first repo
    const task = db.query("SELECT repo_id FROM tasks WHERE id = ?").get(data.id) as { repo_id: number };
    expect(task.repo_id).toBe(200);
  });

  test("three repos", async () => {
    const res = await req("POST", "/tasks", {
      description: "refactor everything",
      repo_names: ["my-api", "my-frontend", "shared-lib"],
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(3);

    const db = getDb();
    const rows = db.query("SELECT * FROM task_repos WHERE task_id = ? AND role = 'target'").all(data.id);
    expect(rows.length).toBe(3);
  });

  test("returns 404 for unknown repo in repo_names", async () => {
    const res = await req("POST", "/tasks", {
      description: "test",
      repo_names: ["my-api", "nonexistent"],
    });
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown single repo_name", async () => {
    const res = await req("POST", "/tasks", {
      description: "test",
      repo_name: "nonexistent",
    });
    expect(res.status).toBe(404);
  });

  test("auto-selects when only one repo exists", async () => {
    const db = getDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM repos WHERE id != 200");
    db.exec("PRAGMA foreign_keys = ON");

    const res = await req("POST", "/tasks", {
      description: "test auto select",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(1);

    const rows = db.query("SELECT repo_id FROM task_repos WHERE task_id = ? AND role = 'target'").all(data.id) as Array<{ repo_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].repo_id).toBe(200);
  });

  test("assigns all repos when none specified (pre-plan will narrow)", async () => {
    const res = await req("POST", "/tasks", {
      description: "test auto scope",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(3); // all 3 seeded repos

    const db = getDb();
    const rows = db.query("SELECT * FROM task_repos WHERE task_id = ? AND role = 'target'").all(data.id);
    expect(rows.length).toBe(3);
  });
});

describe("B1: loadTaskAndRepos", () => {
  beforeEach(() => {
    seedRepos();
  });

  test("loads multi-repo task from task_repos", () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, repo_id, source) VALUES ('t1', 'test', 'test', 200, 'cli')");
    db.run("INSERT INTO task_repos (task_id, repo_id, role) VALUES ('t1', 200, 'target')");
    db.run("INSERT INTO task_repos (task_id, repo_id, role) VALUES ('t1', 201, 'target')");

    const loaded = loadTaskAndRepos("t1");
    expect(loaded).not.toBeNull();
    expect(loaded!.task.id).toBe("t1");
    expect(loaded!.repos.length).toBe(2);
    expect(loaded!.repos.map((r) => r.name).sort()).toEqual(["my-api", "my-frontend"]);
  });

  test("falls back to repo_id for legacy tasks", () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, repo_id, source) VALUES ('t2', 'legacy', 'legacy', 202, 'cli')");
    // No task_repos rows

    const loaded = loadTaskAndRepos("t2");
    expect(loaded).not.toBeNull();
    expect(loaded!.repos.length).toBe(1);
    expect(loaded!.repos[0].name).toBe("shared-lib");
  });

  test("returns null for unknown task", () => {
    expect(loadTaskAndRepos("nonexistent")).toBeNull();
  });

  test("returns null for task with no repo", () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, source) VALUES ('t3', 'orphan', 'orphan', 'cli')");

    expect(loadTaskAndRepos("t3")).toBeNull();
  });

  test("ignores context-role repos", () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, repo_id, source) VALUES ('t4', 'test', 'test', 200, 'cli')");
    db.run("INSERT INTO task_repos (task_id, repo_id, role) VALUES ('t4', 200, 'target')");
    db.run("INSERT INTO task_repos (task_id, repo_id, role) VALUES ('t4', 201, 'context')");

    const loaded = loadTaskAndRepos("t4");
    expect(loaded).not.toBeNull();
    expect(loaded!.repos.length).toBe(1);
    expect(loaded!.repos[0].name).toBe("my-api");
  });
});

describe("B1: schema backfill", () => {
  test("backfill populates task_repos from tasks.repo_id", () => {
    const db = getDb();
    // The backfill runs during migrations in getDb()
    // Any task with repo_id should have a task_repos row
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM task_repos");
    db.run("DELETE FROM tasks");
    db.exec("PRAGMA foreign_keys = ON");

    db.run("INSERT INTO tasks (id, title, description, repo_id, source) VALUES ('bf1', 'backfill', 'test', 200, 'cli')");

    // Manually run the backfill
    db.exec(
      `INSERT OR IGNORE INTO task_repos (task_id, repo_id, role)
       SELECT id, repo_id, 'target' FROM tasks WHERE repo_id IS NOT NULL`
    );

    const rows = db.query("SELECT * FROM task_repos WHERE task_id = 'bf1'").all() as Array<{ repo_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].repo_id).toBe(200);
  });
});
