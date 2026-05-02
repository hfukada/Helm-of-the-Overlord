import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-tasks";

mock.module("../src/orchestrator/task-runner", () => ({
  runTask: async () => {},
  cleanupTask: async () => {},
  restartTaskPhase: async () => {},
}));

mock.module("../src/workspace/git", () => ({
  getDiff: async () => null,
  getDiffSummary: async () => null,
  createTaskClone: async () => "/tmp/worktree",
}));

mock.module("../src/workspace/manager", () => ({
  worktreeDir: () => "/tmp/worktree",
}));

mock.module("../src/messaging/manager", () => ({
  getMessagingManager: () => null,
}));

mock.module("../src/shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { getDb } from "../src/knowledge/db";

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-tasks", { recursive: true });
  getDb();
  const { tasks } = await import("../src/daemon/routes/tasks");
  app = new Hono();
  app.route("/tasks", tasks);
});

beforeEach(() => {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM agent_runs");
  db.run("DELETE FROM tasks");
  db.exec("PRAGMA foreign_keys = ON");
});

async function get(path: string) {
  return app.request(path, { method: "GET" });
}

describe("GET /tasks", () => {
  test("returns empty array when no tasks exist", async () => {
    const res = await get("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns total_tokens: 0 for a task with no agent runs", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('t1', 'Test task', 'desc', 'pending')"
    );

    const res = await get("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("t1");
    expect(body[0].total_tokens).toBe(0);
  });

  test("returns total_tokens as sum of token_input + token_output across all agent runs", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('t2', 'Token task', 'desc', 'implementing')"
    );
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output)
       VALUES ('r1', 't2', 'plan', 'agentic', 'completed', 'plan prompt', 'claude-3', 100, 250)`
    );
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output)
       VALUES ('r2', 't2', 'implement', 'agentic', 'completed', 'impl prompt', 'claude-3', 200, 400)`
    );

    const res = await get("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("t2");
    expect(body[0].total_tokens).toBe(950); // 100+250+200+400
  });

  test("total_tokens is independent per task", async () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, status) VALUES ('ta', 'Task A', 'desc', 'pending')");
    db.run("INSERT INTO tasks (id, title, description, status) VALUES ('tb', 'Task B', 'desc', 'pending')");
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output)
       VALUES ('ra', 'ta', 'plan', 'agentic', 'completed', 'p', 'claude-3', 50, 50)`
    );

    const res = await get("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const taskA = body.find((t) => t.id === "ta");
    const taskB = body.find((t) => t.id === "tb");
    expect(taskA?.total_tokens).toBe(100);
    expect(taskB?.total_tokens).toBe(0);
  });
});

describe("POST /tasks/:id/restart", () => {
  test("returns 404 for unknown task ID", async () => {
    const res = await app.request("/tasks/NOTEXIST/restart", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns 204 for valid task ID", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('restart1', 'Restart task', 'desc', 'implementing')"
    );
    const res = await app.request("/tasks/restart1/restart", { method: "POST" });
    expect(res.status).toBe(204);
  });

  test("clears agent_runs after restart", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('restart2', 'Restart task 2', 'desc', 'review')"
    );
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
       VALUES ('run1', 'restart2', 'plan', 'agentic', 'completed', 'p', 'claude-3')`
    );
    await app.request("/tasks/restart2/restart", { method: "POST" });
    const runs = db.query("SELECT id FROM agent_runs WHERE task_id = ?").all("restart2");
    expect(runs).toHaveLength(0);
  });

  test("resets task status to running after restart", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('restart3', 'Restart task 3', 'desc', 'committed')"
    );
    await app.request("/tasks/restart3/restart", { method: "POST" });
    const task = db.query("SELECT status FROM tasks WHERE id = ?").get("restart3") as { status: string };
    expect(task.status).toBe("running");
  });
});
