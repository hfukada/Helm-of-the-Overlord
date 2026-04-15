import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/knowledge/db";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-messaging-project";

const { mock } = await import("bun:test");
const realModule = await import("../src/orchestrator/task-runner");

mock.module("../src/orchestrator/task-runner", () => ({
  ...realModule,
  runTask: async () => {},
  cleanupTask: async () => {},
}));

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-messaging-project", { recursive: true });
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

  db.run("INSERT INTO repos (id, name, path, language) VALUES (300, 'my-api', '/tmp/my-api', 'typescript')");
  db.run("INSERT INTO repos (id, name, path, language) VALUES (301, 'my-frontend', '/tmp/my-frontend', 'typescript')");
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("messaging project creation", () => {
  beforeEach(() => {
    seedRepos();
  });

  test("creates task with explicit title and source=messaging", async () => {
    const res = await req("POST", "/tasks", {
      title: "My Project",
      description: "",
      source: "messaging",
      repo_name: "my-api",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; title: string };
    expect(data.title).toBe("My Project");

    const db = getDb();
    const task = db.query("SELECT title, source FROM tasks WHERE id = ?").get(data.id) as { title: string; source: string };
    expect(task.title).toBe("My Project");
    expect(task.source).toBe("messaging");
  });

  test("explicit title is not overwritten by description truncation", async () => {
    const longDesc = "A".repeat(200);
    const res = await req("POST", "/tasks", {
      title: "My Project",
      description: longDesc,
      source: "messaging",
      repo_name: "my-api",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; title: string };

    const db = getDb();
    const task = db.query("SELECT title, description FROM tasks WHERE id = ?").get(data.id) as { title: string; description: string };
    expect(task.title).toBe("My Project");      // not truncated description
    expect(task.description).toBe(longDesc);    // description stored separately
  });

  test("multi-repo project creates multiple task_repos rows", async () => {
    const res = await req("POST", "/tasks", {
      title: "Cross-Repo Project",
      description: "",
      source: "messaging",
      repo_names: ["my-api", "my-frontend"],
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; repo_count: number };
    expect(data.repo_count).toBe(2);

    const db = getDb();
    const rows = db.query(
      "SELECT repo_id FROM task_repos WHERE task_id = ? ORDER BY repo_id"
    ).all(data.id) as Array<{ repo_id: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0].repo_id).toBe(300);
    expect(rows[1].repo_id).toBe(301);
  });

  test("empty title string does not 400 — route uses it as-is (?? does not coerce empty string)", async () => {
    // "" is not nullish so title ?? description.slice() keeps "".
    // The route returns 201; title validation is the messaging layer's responsibility.
    const res = await req("POST", "/tasks", {
      title: "",
      description: "fallback desc",
      source: "messaging",
      repo_name: "my-api",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; title: string };

    const db = getDb();
    const task = db.query("SELECT title FROM tasks WHERE id = ?").get(data.id) as { title: string };
    expect(task.title).toBe(""); // "" is preserved, not replaced by truncated description
  });

  test("unknown repo_name returns 404", async () => {
    const res = await req("POST", "/tasks", {
      title: "My Project",
      description: "",
      source: "messaging",
      repo_name: "nonexistent",
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
  });
});
