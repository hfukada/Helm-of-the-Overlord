import { Hono } from "hono";
import { Registry, Gauge, Histogram } from "prom-client";
import { getDb } from "../../knowledge/db";

const registry = new Registry();

new Gauge({
  name: "hoto_tokens_input_total",
  help: "Total input tokens consumed across all runs",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COALESCE(SUM(input_tokens),0) AS v FROM token_usage_daily").get() as { v: number };
    this.set(row.v);
  },
});

new Gauge({
  name: "hoto_tokens_output_total",
  help: "Total output tokens consumed across all runs",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COALESCE(SUM(output_tokens),0) AS v FROM token_usage_daily").get() as { v: number };
    this.set(row.v);
  },
});

new Gauge({
  name: "hoto_cost_usd_total",
  help: "Total cost in USD across all runs",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COALESCE(SUM(cost_usd),0) AS v FROM token_usage_daily").get() as { v: number };
    this.set(row.v);
  },
});

new Gauge({
  name: "hoto_agent_runs",
  help: "Agent run count by status",
  labelNames: ["status"] as const,
  registers: [registry],
  collect() {
    this.reset();
    const rows = getDb().query("SELECT status, COUNT(*) AS count FROM agent_runs GROUP BY status").all() as Array<{ status: string; count: number }>;
    for (const r of rows) {
      this.set({ status: r.status }, r.count);
    }
  },
});

new Histogram({
  name: "hoto_agent_run_duration_ms",
  help: "Agent run duration in milliseconds, labelled by node_name, model, and status",
  labelNames: ["node_name", "model", "status"] as const,
  buckets: [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000],
  registers: [registry],
  collect() {
    this.reset();
    const rows = getDb().query(
      `SELECT node_name, model, status,
              CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400000) AS INTEGER) AS duration_ms
       FROM agent_runs
       WHERE started_at IS NOT NULL AND finished_at IS NOT NULL`
    ).all() as Array<{ node_name: string; model: string; status: string; duration_ms: number }>;
    for (const r of rows) {
      this.observe({ node_name: r.node_name, model: r.model, status: r.status }, r.duration_ms);
    }
  },
});

new Gauge({
  name: "hoto_tasks_active",
  help: "Currently active (non-terminal) task count",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COUNT(*) AS v FROM tasks WHERE status NOT IN ('committed','cancelled','error')").get() as { v: number };
    this.set(row.v);
  },
});

new Gauge({
  name: "hoto_tasks_total",
  help: "Task count by status",
  labelNames: ["status"] as const,
  registers: [registry],
  collect() {
    this.reset();
    const rows = getDb().query("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all() as Array<{ status: string; count: number }>;
    for (const r of rows) {
      this.set({ status: r.status }, r.count);
    }
  },
});

new Histogram({
  name: "hoto_task_duration_ms",
  help: "Task duration in milliseconds (created_at to updated_at) for terminal-status tasks",
  buckets: [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000],
  registers: [registry],
  collect() {
    this.reset();
    const rows = getDb().query(
      `SELECT CAST(ROUND((julianday(updated_at) - julianday(created_at)) * 86400000) AS INTEGER) AS duration_ms
       FROM tasks
       WHERE created_at IS NOT NULL
         AND updated_at IS NOT NULL
         AND status IN ('committed', 'cancelled', 'error')`
    ).all() as Array<{ duration_ms: number }>;
    for (const r of rows) {
      this.observe(r.duration_ms);
    }
  },
});

new Gauge({
  name: "hoto_task_agent_run_count",
  help: "Total number of agent runs across all tasks",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COUNT(*) AS count FROM agent_runs").get() as { count: number };
    this.set(row.count);
  },
});

export const metrics = new Hono();

metrics.get("/", async (c) =>
  c.text(await registry.metrics(), 200, { "Content-Type": registry.contentType })
);
