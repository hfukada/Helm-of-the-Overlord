import { Hono } from "hono";
import { getDb } from "../../knowledge/db";

function formatMetric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  samples: Array<{ labels?: Record<string, string>; value: number }>
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    if (s.labels && Object.keys(s.labels).length > 0) {
      const labelStr = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      lines.push(`${name}{${labelStr}} ${s.value}`);
    } else {
      lines.push(`${name} ${s.value}`);
    }
  }
  return lines.join("\n");
}

export const metrics = new Hono();

metrics.get("/", (c) => {
  const db = getDb();

  const totals = db
    .query(
      "SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cost_usd),0) AS cost FROM token_usage_daily"
    )
    .get() as { input: number; output: number; cost: number };

  const runsByStatus = db
    .query("SELECT status, COUNT(*) AS count FROM agent_runs GROUP BY status")
    .all() as Array<{ status: string; count: number }>;

  const activeCount = db
    .query(
      "SELECT COUNT(*) AS count FROM tasks WHERE status NOT IN ('committed','cancelled','error')"
    )
    .get() as { count: number };

  const body = [
    formatMetric("hoto_tokens_input_total", "Total input tokens consumed across all runs", "counter", [
      { value: totals.input },
    ]),
    formatMetric("hoto_tokens_output_total", "Total output tokens consumed across all runs", "counter", [
      { value: totals.output },
    ]),
    formatMetric("hoto_cost_usd_total", "Total cost in USD across all runs", "counter", [
      { value: totals.cost },
    ]),
    formatMetric(
      "hoto_agent_runs",
      "Agent run count by status",
      "gauge",
      runsByStatus.map((r) => ({ labels: { status: r.status }, value: r.count }))
    ),
    formatMetric("hoto_tasks_active", "Currently active (non-terminal) task count", "gauge", [
      { value: activeCount.count },
    ]),
  ].join("\n\n");

  return c.text(body, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});
