import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Registry } from "prom-client";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-metrics";

import { getDb } from "../src/knowledge/db";
import { initTokenCounters } from "../src/shared/token-counters";

let app: Hono;
let freshRegistry: Registry;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-metrics", { recursive: true });
  getDb();
  const { metrics } = await import("../src/daemon/routes/metrics");
  app = new Hono();
  app.route("/metrics", metrics);
});

beforeEach(async () => {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM agent_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM token_usage_daily");
  db.exec("PRAGMA foreign_keys = ON");
  freshRegistry = new Registry();
  await initTokenCounters(db, freshRegistry);
});

function seed() {
  const db = getDb();
  // tasks first — agent_runs has REFERENCES tasks(id)
  db.run("INSERT INTO tasks (id, title, description, status) VALUES ('t1', 'Task 1', 'desc', 'implementing')");
  db.run("INSERT INTO tasks (id, title, description, status) VALUES ('t2', 'Task 2', 'desc', 'pending')");
  db.run("INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES ('t3', 'Task 3', 'desc', 'committed', '2024-01-01T00:00:00.000Z', '2024-01-01T00:05:00.000Z')");
  // agent_runs — 2 done, 1 error
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, started_at, finished_at) VALUES ('r1', 't1', 'implement', 'claude', 'done', 'p', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:02.000Z')"
  );
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, started_at, finished_at) VALUES ('r2', 't2', 'plan', 'claude', 'error', 'p', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:01:00.000Z')"
  );
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, started_at, finished_at) VALUES ('r3', 't3', 'review', 'claude', 'done', 'p', 'claude-3', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:20.000Z')"
  );
  // token data via agent_runs — totals: input=3000, output=1500, cost=4.0
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output, cost_usd) VALUES ('tok1', 't1', 'test-phase', 'claude', 'completed', 'p', 'claude-3', 3000, 1500, 4.0)"
  );
}

describe("GET /metrics", () => {
  test("returns 200 with text/plain content type", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  test("body contains all expected metric names", async () => {
    seed();
    freshRegistry = new Registry();
    await initTokenCounters(getDb(), freshRegistry);
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain('hoto_tokens_input_total{model="');
    expect(body).toContain('hoto_tokens_output_total{model="');
    expect(body).toContain('hoto_cost_usd_total{model="');
    expect(body).toContain("hoto_agent_runs");
    expect(body).toContain("hoto_tasks_active");
    expect(body).toContain("hoto_agent_run_duration_ms");
    expect(body).toContain("hoto_tasks_total");
    expect(body).toContain("hoto_task_duration_ms");
    expect(body).toContain("hoto_task_agent_run_count");
  });

  test("numeric values match seeded data", async () => {
    seed();
    freshRegistry = new Registry();
    await initTokenCounters(getDb(), freshRegistry);
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    // token totals come from tok1 agent_run (3000/1500/4.0) under test-phase
    expect(body).toContain('hoto_tokens_input_total{model="claude-3",node_name="test-phase"} 3000');
    expect(body).toContain('hoto_tokens_output_total{model="claude-3",node_name="test-phase"} 1500');
    expect(body).toContain('hoto_cost_usd_total{model="claude-3",node_name="test-phase"} 4');
    // r1+r3 = done×2, r2 = error×1
    expect(body).toContain('hoto_agent_runs{status="done"} 2');
    expect(body).toContain('hoto_agent_runs{status="error"} 1');
    // t1 (implementing) + t2 (pending) = 2 active; t3 (committed) is terminal
    expect(body).toContain("hoto_tasks_active 2");
    expect(body).toContain('hoto_tasks_total{status="implementing"} 1');
    expect(body).toContain('hoto_tasks_total{status="pending"} 1');
    expect(body).toContain('hoto_tasks_total{status="committed"} 1');
    expect(body).toContain("hoto_task_agent_run_count 4");
  });

  test("returns zeros and no agent_run lines when tables are empty", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).not.toContain("hoto_tokens_input_total{");
    expect(body).not.toContain("hoto_tokens_output_total{");
    expect(body).not.toContain("hoto_cost_usd_total{");
    expect(body).toContain("hoto_tasks_active 0");
    expect(body).not.toContain('hoto_agent_runs{');
    expect(body).not.toContain('hoto_tasks_total{');
    expect(body).not.toContain('hoto_task_duration_ms_count{');
    expect(body).toContain("hoto_task_agent_run_count 0");
  });

  test("histogram emits correct labels, count, and sum for seeded runs", async () => {
    seed();
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain("hoto_agent_run_duration_ms_bucket");
    expect(body).toContain('node_name="implement"');
    expect(body).toContain('node_name="plan"');
    // r1: implement/claude-3/done, 2000ms
    expect(body).toContain('hoto_agent_run_duration_ms_count{node_name="implement",model="claude-3",status="done"} 1');
    expect(body).toContain('hoto_agent_run_duration_ms_sum{node_name="implement",model="claude-3",status="done"} 2000');
  });

  test("histogram has no labelled samples when agent_runs table is empty", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain("hoto_agent_run_duration_ms");
    expect(body).not.toContain("hoto_agent_run_duration_ms_count{");
  });

  test("histogram ignores rows with NULL finished_at", async () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, status) VALUES ('tn', 'Null Task', 'desc', 'implementing')");
    db.run(
      "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, started_at, finished_at) VALUES ('rn1', 'tn', 'implement', 'claude', 'running', 'p', 'claude-3', '2024-01-01T00:00:00.000Z', NULL)"
    );
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).not.toContain("hoto_agent_run_duration_ms_count{");
  });

  test("hoto_task_duration_ms histogram emits correct sum for completed task", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES ('td', 'Duration Task', 'desc', 'committed', '2024-01-01T00:00:00.000Z', '2024-01-01T00:05:00.000Z')"
    );
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain("hoto_task_duration_ms_count 1");
    expect(body).toContain("hoto_task_duration_ms_sum 300000");
  });

  test("hoto_task_duration_ms ignores tasks without terminal status", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES ('ti', 'In Progress Task', 'desc', 'implementing', '2024-01-01T00:00:00.000Z', '2024-01-01T00:05:00.000Z')"
    );
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).not.toContain("hoto_task_duration_ms_count{");
    expect(body).not.toContain("hoto_task_duration_ms_count 1");
  });

  test("two models produce two labelled lines", async () => {
    const db = getDb();
    db.run("INSERT INTO tasks (id, title, description, status) VALUES ('tm1', 'Model Task', 'desc', 'implementing')");
    db.run("INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output, cost_usd) VALUES ('rm1', 'tm1', 'test-phase', 'claude', 'completed', 'p', 'claude-3', 1000, 500, 0.01)");
    db.run("INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, token_input, token_output, cost_usd) VALUES ('rm2', 'tm1', 'test-phase', 'claude', 'completed', 'p', 'claude-opus-4', 2000, 1000, 0.04)");
    freshRegistry = new Registry();
    await initTokenCounters(db, freshRegistry);
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain('hoto_tokens_input_total{model="claude-3",node_name="test-phase"} 1000');
    expect(body).toContain('hoto_tokens_input_total{model="claude-opus-4",node_name="test-phase"} 2000');
  });

  test("hoto_task_lines_changed emits correct label sets", async () => {
    const db = getDb();
    db.run(
      "INSERT INTO tasks (id, title, description, status, diff_lines_added, diff_lines_deleted, diff_lines_modified) VALUES ('42', 'Test Task', 'desc', 'committed', 1, 0, 1)"
    );
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain('hoto_task_lines_changed{task_id="42",type="addition"} 1');
    expect(body).toContain('hoto_task_lines_changed{task_id="42",type="deletion"} 0');
    expect(body).toContain('hoto_task_lines_changed{task_id="42",type="modification"} 1');
  });
});
