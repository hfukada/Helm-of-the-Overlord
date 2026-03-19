import { Hono } from "hono";
import { getDb } from "../../knowledge/db";

const agents = new Hono();

agents.get("/:taskId/agents", (c) => {
  const taskId = c.req.param("taskId");
  const db = getDb();

  const runs = db.query(
    `SELECT id, node_name, agent_type, status, token_input, token_output,
            cost_usd, model, started_at, finished_at, error
     FROM agent_runs WHERE task_id = ? ORDER BY started_at`
  ).all(taskId);

  return c.json(runs);
});

agents.get("/:taskId/agents/:runId/stream", (c) => {
  const runId = c.req.param("runId");
  const after = parseInt(c.req.query("after") ?? "0", 10);
  const db = getDb();

  const events = db.query(
    `SELECT id, event_type, content, timestamp
     FROM agent_stream WHERE agent_run_id = ? AND id > ?
     ORDER BY id LIMIT 200`
  ).all(runId, after);

  return c.json(events);
});

export { agents };
