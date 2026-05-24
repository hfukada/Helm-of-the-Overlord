import { Counter, Registry } from "prom-client";
import type { Database } from "bun:sqlite";

export let tokenRegistry: Registry = new Registry();

let inputCounter: Counter;
let outputCounter: Counter;
let costCounter: Counter;

function ensureCounters(registry: Registry): void {
  if (inputCounter) return;
  inputCounter = new Counter({
    name: "hoto_tokens_input_total",
    help: "Total input tokens consumed, by model",
    labelNames: ["model"],
    registers: [registry],
  });
  outputCounter = new Counter({
    name: "hoto_tokens_output_total",
    help: "Total output tokens consumed, by model",
    labelNames: ["model"],
    registers: [registry],
  });
  costCounter = new Counter({
    name: "hoto_cost_usd_total",
    help: "Total cost in USD, by model",
    labelNames: ["model"],
    registers: [registry],
  });
}

/**
 * Call once at daemon startup. Optionally pass a custom registry for testing.
 */
export async function initTokenCounters(
  db: Database,
  registry: Registry = tokenRegistry
): Promise<void> {
  inputCounter = undefined as unknown as Counter;
  outputCounter = undefined as unknown as Counter;
  costCounter = undefined as unknown as Counter;
  tokenRegistry = registry;

  ensureCounters(registry);

  const rows = db
    .query<
      { model: string; input_tokens: number; output_tokens: number; cost_usd: number },
      []
    >(
      "SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd FROM token_usage_daily GROUP BY model"
    )
    .all();

  for (const row of rows) {
    const model = row.model ?? "unknown";
    if (row.input_tokens > 0) inputCounter.inc({ model }, row.input_tokens);
    if (row.output_tokens > 0) outputCounter.inc({ model }, row.output_tokens);
    if (row.cost_usd > 0) costCounter.inc({ model }, row.cost_usd);
  }
}

/**
 * Called by persistence.ts after each agent run completion.
 */
export function incrementTokenCounters(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): void {
  if (!inputCounter) return;
  const label = model ?? "unknown";
  if (inputTokens > 0) inputCounter.inc({ model: label }, inputTokens);
  if (outputTokens > 0) outputCounter.inc({ model: label }, outputTokens);
  if (costUsd > 0) costCounter.inc({ model: label }, costUsd);
}
