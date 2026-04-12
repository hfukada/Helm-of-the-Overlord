import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";
import { logger } from "../../../shared/logger";
import type { SandboxOptions } from "./types";

function recordRun(
  agentRunId: string,
  _taskId: string,
  _nodeName: string,
  _prompt: string,
  model: string,
  result: { output: string; error: string | null; usage: { input_tokens: number; output_tokens: number; cost_usd: number } }
): void {
  const db = getDb();
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
}

export async function executeFixCi(
  task: Task,
  repo: Repo,
  workDir: string,
  ciOutput: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
  sandbox?: SandboxOptions,
): Promise<{ output: string; error: string | null }> {
  const model = config.defaultModel;
  const db = getDb();

  const readTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  // === Step 1: Plan the fix ===
  const planRunId = ulid();
  const planPrompt = await renderTemplate("fix-ci-plan", { ciOutput });

  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, child_task_id)
     VALUES (?, ?, 'fix_ci_plan', 'agentic', 'running', ?, ?, ?)`,
    [planRunId, task.id, planPrompt, model, task.child_task_id ?? null]
  );

  logger.info("Planning CI fix", { taskId: task.id });

  const planResult = await runClaude({
    prompt: planPrompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: 12,
    allowedTools: readTools,
    mcpConfigPath,
    addDirs: [workDir],
    agentRunId: planRunId,
    taskId: task.id,
    onEvent,
    containerName: sandbox?.containerName,
    containerWorkDir: sandbox?.containerWorkDir,
  });

  recordRun(planRunId, task.id, "fix_ci_plan", planPrompt, model, planResult);

  if (planResult.error || planResult.output.length < 50) {
    logger.warn("CI fix planning failed", { taskId: task.id, error: planResult.error });
    return { output: planResult.output, error: planResult.error ?? "Fix plan too short" };
  }

  // === Step 2: Implement the fix ===
  const implRunId = ulid();
  const implPrompt = await renderTemplate("fix-ci", {
    fixPlan: planResult.output,
    ciOutput,
  });

  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, child_task_id)
     VALUES (?, ?, 'fix_ci', 'agentic', 'running', ?, ?, ?)`,
    [implRunId, task.id, implPrompt, model, task.child_task_id ?? null]
  );

  // Estimate turns from the fix plan (same heuristic as implement phase)
  const fileRefs = planResult.output.match(/`[^`]+\.\w+`/g) ?? [];
  const uniqueFiles = new Set(fileRefs.map((f: string) => f.replace(/`/g, ""))).size;
  const estimatedTurns = Math.max(10, Math.min(30, 3 + Math.ceil(uniqueFiles * 2.5)));
  logger.info("Implementing CI fix", { taskId: task.id, uniqueFiles, estimatedTurns });

  const implResult = await runClaude({
    prompt: implPrompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: estimatedTurns,
    allowedTools: [...readTools, "Write", "Edit", "Bash"],
    mcpConfigPath,
    addDirs: [workDir],
    agentRunId: implRunId,
    taskId: task.id,
    onEvent,
    containerName: sandbox?.containerName,
    containerWorkDir: sandbox?.containerWorkDir,
  });

  recordRun(implRunId, task.id, "fix_ci", implPrompt, model, implResult);

  return { output: implResult.output, error: implResult.error };
}
