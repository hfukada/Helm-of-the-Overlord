import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildImplementPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";

const MIN_TURNS = 15;
const MAX_TURNS = 50;

/**
 * Estimate the number of tool turns needed based on the plan content.
 * Heuristic: ~3 baseline + ~2.5 per unique file + ~1 per new file.
 */
function estimateTurns(plan: string): number {
  // Count unique file paths referenced in backticks
  const fileRefs = plan.match(/`[^`]+\.\w+`/g) ?? [];
  const uniqueFiles = new Set(fileRefs.map((f) => f.replace(/`/g, ""))).size;

  // Count new file indicators
  const newFiles = (plan.match(/\(new\s*file\)|\bnew file\b|\(create\)/gi) ?? []).length;

  const estimate = 3 + Math.ceil(uniqueFiles * 2.5) + newFiles;
  const clamped = Math.max(MIN_TURNS, Math.min(MAX_TURNS, estimate));

  logger.info("Estimated implement turns", { uniqueFiles, newFiles, estimate, clamped });
  return clamped;
}

export async function executeImplement(
  task: Task,
  repos: Repo[],
  workDir: string,
  plan: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();

  const prompt = await buildImplementPrompt(task, repos, plan);

  const repoNames = repos.map((r) => r.name).join(", ");
  const systemPrompt = `You are working on: ${repoNames}. Your working directory is ${workDir}. ALL file paths for Write/Edit/Read MUST be absolute paths under ${workDir}. For example: ${workDir}/src/foo.ts. Do NOT create files outside of ${workDir} -- files outside the repo worktree will not be committed. You have access to Read, Write, Edit, Glob, Grep, and Bash tools. Do not run destructive commands. Do not push to git.`;

  const model = config.defaultModel;

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'implement', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

  const allowedTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "Read", "Glob", "Grep", "Write", "Edit", "Bash"]
    : ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

  const maxTurns = estimateTurns(plan);

  const result = await runClaude({
    prompt,
    systemPrompt,
    workDir,
    model,
    maxTurns,
    allowedTools,
    mcpConfigPath,
    addDirs: [workDir],
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
