import { Hono } from "hono";
import { getDb } from "../../knowledge/db";

const tokens = new Hono();

tokens.get("/", (c) => {
  const db = getDb();
  const rows = db.query(
    `SELECT date, model, input_tokens, output_tokens, cost_usd
     FROM token_usage_daily ORDER BY date DESC LIMIT 30`
  ).all();

  const totals = db.query(
    `SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(cost_usd) as total_cost
     FROM token_usage_daily`
  ).get() as { total_input: number; total_output: number; total_cost: number };

  return c.json({ daily: rows, totals });
});

export { tokens };
