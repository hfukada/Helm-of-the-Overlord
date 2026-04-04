import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt } from "../../context-builder";
import { renderTemplate } from "../../../prompts/loader";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { search } from "../../../knowledge/search";
import { logger } from "../../../shared/logger";

async function getKnowledgeContext(query: string, repoId: number): Promise<string> {
  try {
    const results = await search({ query, repo_id: repoId, limit: 8 });
    if (results.length === 0) return "";
    return `## Knowledge Base\n${results.map((r: { title: string; content: string }) => `### ${r.title}\n${r.content}`).join("\n\n")}`;
  } catch {
    return "";
  }
}

function getChatContext(taskId: string): string {
  const db = getDb();
  const messages = db.query(
    "SELECT source, sender_id, content FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 20"
  ).all(taskId) as Array<{ source: string; sender_id: string | null; content: string }>;

  if (messages.length === 0) return "";
  return messages.reverse().map((m) => `${m.sender_id ?? m.source}: ${m.content}`).join("\n");
}

function saveAgentRun(
  agentRunId: string,
  taskId: string,
  nodeName: string,
  prompt: string,
  model: string,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, ?, 'agentic', 'running', ?, ?)`,
    [agentRunId, taskId, nodeName, prompt, model]
  );
}

function finishAgentRun(
  agentRunId: string,
  result: { output: string; error: string | null; usage: { input_tokens: number; output_tokens: number; cost_usd: number } },
  model: string,
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

/**
 * Triage review feedback as "small" (targeted fixes) or "large" (structural changes).
 */
export async function executeUnderstandReview(
  task: Task,
  repo: Repo,
  workDir: string,
  feedback: string,
  previousPlan: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
): Promise<{ verdict: "small" | "large"; output: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const prompt = await renderTemplate("understand-review", {
    taskDescription: task.description,
    previousPlan,
    feedback,
  });

  saveAgentRun(agentRunId, task.id, "understand_review", prompt, model);

  const allowedTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: 3,
    allowedTools,
    mcpConfigPath,
    agentRunId,
    taskId: task.id,
    onEvent,
  });

  finishAgentRun(agentRunId, result, model);

  if (result.error) {
    return { verdict: "large", output: result.output, error: result.error };
  }

  // Parse verdict from output -- look for VERDICT: SMALL or VERDICT: LARGE
  const verdictMatch = result.output.match(/VERDICT:\s*(SMALL|LARGE)/i);
  const verdict = verdictMatch?.[1]?.toLowerCase() === "small" ? "small" : "large";

  logger.info("Review feedback triaged", { taskId: task.id, verdict });
  return { verdict, output: result.output, error: null };
}

/**
 * Plan targeted fixes for small review feedback. Goes straight to implement.
 */
export async function executeReviewSmallFeedback(
  task: Task,
  repo: Repo,
  workDir: string,
  feedback: string,
  previousPlan: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const prompt = await renderTemplate("review-small-feedback", {
    taskDescription: task.description,
    previousPlan,
    feedback,
  });

  saveAgentRun(agentRunId, task.id, "review_small_feedback", prompt, model);

  const allowedTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "Read", "Glob", "Grep"]
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

  finishAgentRun(agentRunId, result, model);
  return { plan: result.output, error: result.error };
}

/**
 * Plan structural changes for large review feedback. Output feeds into scrutinize loop.
 */
export async function executeReviewLargeFeedback(
  task: Task,
  repo: Repo,
  workDir: string,
  feedback: string,
  previousPlan: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  const knowledgeContext = repo.id ? await getKnowledgeContext(task.description, repo.id) : "";
  const chatContext = getChatContext(task.id);

  // Get lint/CI status from DB
  const db = getDb();
  const row = db.query(
    "SELECT lint_passed, lint_output, ci_passed, ci_output FROM tasks WHERE id = ?"
  ).get(task.id) as {
    lint_passed: number | null;
    lint_output: string | null;
    ci_passed: number | null;
    ci_output: string | null;
  } | null;

  const lintPassed = row?.lint_passed;
  const ciPassed = row?.ci_passed;
  const lintErrors = lintPassed === 0 && row?.lint_output ? row.lint_output.slice(0, 3000) : undefined;
  const ciErrors = ciPassed === 0 && row?.ci_output ? row.ci_output.slice(0, 3000) : undefined;

  const prompt = await renderTemplate("review-large-feedback", {
    taskDescription: task.description,
    previousPlan,
    feedback,
    lintStatus: lintPassed !== null ? (lintPassed ? "passed" : "failed") : undefined,
    lintErrors,
    ciStatus: ciPassed !== null ? (ciPassed ? "passed" : "failed") : undefined,
    ciErrors,
    chatContext: chatContext || undefined,
    knowledgeContext: knowledgeContext || undefined,
  });

  saveAgentRun(agentRunId, task.id, "review_large_feedback", prompt, model);

  const allowedTools = mcpConfigPath
    ? ["mcp__hoto__search_knowledge", "Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  const result = await runClaude({
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp: !!mcpConfigPath }),
    workDir,
    model,
    maxTurns: 10,
    allowedTools,
    mcpConfigPath,
    agentRunId,
    taskId: task.id,
    onEvent,
  });

  finishAgentRun(agentRunId, result, model);
  return { plan: result.output, error: result.error };
}
