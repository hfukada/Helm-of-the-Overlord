import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";

export async function executeFixLint(
  task: Task,
  repo: Repo,
  workDir: string,
  lintOutput: string,
  lintCommand: string,
  onEvent?: (type: string, content: string) => void
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const prompt = [
    "You are a lint-fixing agent. Fix all lint errors shown below.",
    "",
    `## Repository: ${repo.name}`,
    `Lint command: ${lintCommand}`,
    "",
    "## Lint Output (errors to fix)",
    "```",
    lintOutput,
    "```",
    "",
    "## Instructions",
    "- Read the files that have lint errors.",
    "- Fix each error. Prefer minimal, targeted fixes.",
    "- Do NOT change logic or add features -- only fix lint issues.",
    "- Do NOT run the lint command yourself.",
  ].join("\n");

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'fix_lint', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo),
    workDir,
    model,
    maxTurns: 10,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    agentRunId,
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

  return { output: result.output, error: result.error };
}
