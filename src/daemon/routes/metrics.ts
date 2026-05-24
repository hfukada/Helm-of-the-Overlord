import { Hono } from "hono";
import { Registry, Gauge } from "prom-client";
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

new Gauge({
  name: "hoto_tasks_active",
  help: "Currently active (non-terminal) task count",
  registers: [registry],
  collect() {
    const row = getDb().query("SELECT COUNT(*) AS v FROM tasks WHERE status NOT IN ('committed','cancelled','error')").get() as { v: number };
    this.set(row.v);
  },
});

export const metrics = new Hono();

metrics.get("/", async (c) =>
  c.text(await registry.metrics(), 200, { "Content-Type": registry.contentType })
);
