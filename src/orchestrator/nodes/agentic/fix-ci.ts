import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt, getChatContext } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";

export async function executeFixCi(
  task: Task,
  repo: Repo,
  workDir: string,
  ciOutput: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const chatContext = await getChatContext(task.id);

  const prompt = await renderTemplate("fix-ci", {
    repoName: repo.name,
    testCmd: repo.test_cmd ?? undefined,
    buildCmd: repo.build_cmd ?? undefined,
    ciOutput,
    chatContext: chatContext || undefined,
  });

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'fix_ci', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

  const mcpReadTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "mcp__hoto__list_files", "mcp__hoto__read_file", "Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: 15,
    allowedTools: [...mcpReadTools, "Write", "Edit", "Bash"],
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
