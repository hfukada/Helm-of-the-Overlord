import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-metrics";

import { getDb } from "../src/knowledge/db";

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-metrics", { recursive: true });
  getDb();
  const { metrics } = await import("../src/daemon/routes/metrics");
  app = new Hono();
  app.route("/metrics", metrics);
});

beforeEach(() => {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM agent_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM token_usage_daily");
  db.exec("PRAGMA foreign_keys = ON");
});

function seed() {
  const db = getDb();
  // tasks first — agent_runs has REFERENCES tasks(id)
  db.run("INSERT INTO tasks (id, title, description, status) VALUES ('t1', 'Task 1', 'desc', 'implementing')");
  db.run("INSERT INTO tasks (id, title, description, status) VALUES ('t2', 'Task 2', 'desc', 'pending')");
  db.run("INSERT INTO tasks (id, title, description, status) VALUES ('t3', 'Task 3', 'desc', 'committed')");
  // agent_runs — 2 done, 1 error
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model) VALUES ('r1', 't1', 'implement', 'claude', 'done', 'p', 'claude-3')"
  );
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model) VALUES ('r2', 't2', 'plan', 'claude', 'error', 'p', 'claude-3')"
  );
  db.run(
    "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model) VALUES ('r3', 't3', 'review', 'claude', 'done', 'p', 'claude-3')"
  );
  // token_usage_daily — two rows across two dates
  db.run(
    "INSERT INTO token_usage_daily (date, model, input_tokens, output_tokens, cost_usd) VALUES ('2024-01-01', 'claude-3', 1000, 500, 1.5)"
  );
  db.run(
    "INSERT INTO token_usage_daily (date, model, input_tokens, output_tokens, cost_usd) VALUES ('2024-01-02', 'claude-3', 2000, 1000, 2.5)"
  );
}

describe("GET /metrics", () => {
  test("returns 200 with text/plain content type", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  test("body contains all expected metric names", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain("hoto_tokens_input_total");
    expect(body).toContain("hoto_tokens_output_total");
    expect(body).toContain("hoto_cost_usd_total");
    expect(body).toContain("hoto_agent_runs");
    expect(body).toContain("hoto_tasks_active");
  });

  test("numeric values match seeded data", async () => {
    seed();
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    // 1000+2000=3000, 500+1000=1500, 1.5+2.5=4
    expect(body).toContain("hoto_tokens_input_total 3000");
    expect(body).toContain("hoto_tokens_output_total 1500");
    expect(body).toContain("hoto_cost_usd_total 4");
    // r1+r3 = done×2, r2 = error×1
    expect(body).toContain('hoto_agent_runs{status="done"} 2');
    expect(body).toContain('hoto_agent_runs{status="error"} 1');
    // t1 (implementing) + t2 (pending) = 2 active; t3 (committed) is terminal
    expect(body).toContain("hoto_tasks_active 2");
  });

  test("returns zeros and no agent_run lines when tables are empty", async () => {
    const res = await app.request("/metrics", { method: "GET" });
    const body = await res.text();
    expect(body).toContain("hoto_tokens_input_total 0");
    expect(body).toContain("hoto_tokens_output_total 0");
    expect(body).toContain("hoto_cost_usd_total 0");
    expect(body).toContain("hoto_tasks_active 0");
    expect(body).not.toContain('hoto_agent_runs{');
  });
});
