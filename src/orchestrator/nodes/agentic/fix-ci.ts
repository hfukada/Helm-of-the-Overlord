import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";

export async function executeFixCi(
  task: Task,
  repo: Repo,
  workDir: string,
  ciOutput: string,
  onEvent?: (type: string, content: string) => void
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const prompt = [
    "You are a CI-fixing agent. The CI/test pipeline has failed. Fix the issues.",
    "",
    `## Repository: ${repo.name}`,
    repo.test_cmd ? `Test command: ${repo.test_cmd}` : "",
    repo.build_cmd ? `Build command: ${repo.build_cmd}` : "",
    "",
    "## CI/Test Output (failures)",
    "```",
    ciOutput,
    "```",
    "",
    "## Instructions",
    "- Analyze the test/build failures.",
    "- Read the relevant source and test files.",
    "- Fix the failures with minimal, targeted changes.",
    "- Do NOT add new tests or features -- only fix what's broken.",
    "- Do NOT run the tests yourself.",
  ].join("\n");

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'fix_ci', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo),
    workDir,
    model,
    maxTurns: 15,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
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
