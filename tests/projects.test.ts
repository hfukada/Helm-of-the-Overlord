import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/knowledge/db";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-projects";

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-projects", { recursive: true });
  getDb();

  const { default: projects } = await import("../src/daemon/routes/projects");
  app = new Hono();
  app.route("/projects", projects);
});

function clearProjects() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM projects");
  db.exec("PRAGMA foreign_keys = ON");
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("projects API", () => {
  beforeEach(() => {
    clearProjects();
  });

  test("GET /projects returns empty array initially", async () => {
    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  test("POST /projects requires only description", async () => {
    const res = await req("POST", "/projects", { description: "A big feature broken into tasks" });
    expect(res.status).toBe(201);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.id).toBe("string");
    expect(data.title).toBe("Planning\u2026");
    expect(data.description).toBe("A big feature broken into tasks");
    expect(data.status).toBe("planning");
    expect(data.architecture_notes).toBeNull();
    expect(data.carry_over_notes).toBeNull();
    expect(typeof data.created_at).toBe("string");
    expect(typeof data.updated_at).toBe("string");
    expect(Array.isArray(data.milestones)).toBe(true);
    expect(typeof data.current_milestone).toBe("number");
  });
  test("POST /projects with architecture_notes", async () => {
    const res = await req("POST", "/projects", {
      description: "Refactor auth system",
      architecture_notes: "Use JWT with refresh tokens",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as Record<string, unknown>;
    expect(data.architecture_notes).toBe("Use JWT with refresh tokens");
  });

  test("POST /projects returns 400 when description missing", async () => {
    const res = await req("POST", "/projects", {});
    expect(res.status).toBe(400);
  });

  test("GET /projects/:id returns project with empty tasks array", async () => {
    const createRes = await req("POST", "/projects", {
      description: "desc",
    });
    const created = await createRes.json() as Record<string, unknown>;

    const res = await req("GET", `/projects/${created.id}`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.id).toBe(created.id);
    expect(Array.isArray(data.tasks)).toBe(true);
    expect((data.tasks as unknown[]).length).toBe(0);
    expect(Array.isArray(data.milestones)).toBe(true);
    expect(typeof data.current_milestone).toBe("number");
  });

  test("GET /projects/:id includes associated tasks", async () => {
    const createRes = await req("POST", "/projects", {
      description: "desc",
    });
    const project = await createRes.json() as Record<string, unknown>;

    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status, source, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["task-001", "First task", "do something", "committed", "cli", project.id]
    );
    db.run(
      "INSERT INTO tasks (id, title, description, status, source, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["task-002", "Second task", "do more", "pending", "cli", project.id]
    );

    const res = await req("GET", `/projects/${project.id}`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    const tasks = data.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(2);
    expect(tasks[0].id).toBe("task-001");
    expect(tasks[1].id).toBe("task-002");
    expect(tasks[0].title).toBe("First task");
  });

  test("GET /projects/:unknown returns 404", async () => {
    const res = await req("GET", "/projects/nonexistent");
    expect(res.status).toBe(404);
  });

  test("GET /projects returns all projects ordered by created_at desc", async () => {
    await req("POST", "/projects", { description: "a" });
    await req("POST", "/projects", { description: "b" });

    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const data = await res.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(2);
    // Most recently created is first
    expect(data[0].description).toBe("b");
    expect(data[1].description).toBe("a");
    expect(Array.isArray(data[0].milestones)).toBe(true);
    expect(Array.isArray(data[1].milestones)).toBe(true);
  });

  test("PATCH /projects/:id updates fields", async () => {
    const createRes = await req("POST", "/projects", {
      description: "original desc",
    });
    const created = await createRes.json() as Record<string, unknown>;

    const res = await req("PATCH", `/projects/${created.id}`, {
      title: "Updated Title",
      status: "completed",
      carry_over_notes: "remember X",
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.title).toBe("Updated Title");
    expect(data.status).toBe("completed");
    expect(data.carry_over_notes).toBe("remember X");
    expect(data.description).toBe("original desc");
  });

  test("PATCH /projects/:id with no valid fields returns 400", async () => {
    const createRes = await req("POST", "/projects", {
      description: "desc",
    });
    const created = await createRes.json() as Record<string, unknown>;

    const res = await req("PATCH", `/projects/${created.id}`, {
      unknown_field: "value",
    });
    expect(res.status).toBe(400);
  });

  test("PATCH /projects/:unknown returns 404", async () => {
    const res = await req("PATCH", "/projects/nonexistent", { title: "x" });
    expect(res.status).toBe(404);
  });

  test("DELETE /projects/:id removes the project", async () => {
    const createRes = await req("POST", "/projects", { description: "to be deleted" });
    const created = await createRes.json() as Record<string, unknown>;

    const delRes = await req("DELETE", `/projects/${created.id}`);
    expect(delRes.status).toBe(200);
    const delData = await delRes.json() as Record<string, unknown>;
    expect(delData.deleted).toBe(true);

    const getRes = await req("GET", `/projects/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});
