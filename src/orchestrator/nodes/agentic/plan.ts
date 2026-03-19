import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildPlanPrompt, buildSystemPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";

export async function executePlan(
  task: Task,
  repo: Repo,
  workDir: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const prompt = await buildPlanPrompt(task, repo);
  const model = config.defaultModel;

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'plan', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

  const allowedTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "mcp__hoto__list_files", "mcp__hoto__read_file", "Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: 5,
    allowedTools,
    mcpConfigPath,
    agentRunId,
    taskId: task.id,
    onEvent,
  });

  const now = new Date().toISOString();
  db.run(
    `UPDATE agent_runs SET
      status = ?, output = ?, token_input = ?, token_output = ?,
      cost_usd = ?, finished_at = ?, error = ?
     WHERE id = ?`,
    [
      result.error ? "failed" : "completed",
      result.output,
      result.usage.input_tokens,
      result.usage.output_tokens,
      result.usage.cost_usd,
      now,
      result.error,
      agentRunId,
    ]
  );

  // Update daily token usage
  const today = new Date().toISOString().slice(0, 10);
  db.run(
    `INSERT INTO token_usage_daily (date, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd`,
    [today, model, result.usage.input_tokens, result.usage.output_tokens, result.usage.cost_usd]
  );

  return { plan: result.output, error: result.error };
}
