import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildSystemPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";
import { search } from "../../../knowledge/search";
import type { SandboxOptions } from "./types";

/**
 * Run the scrutinize phase: review a plan against the 10-point checklist.
 */
export async function executeScrutinize(
  task: Task,
  repo: Repo,
  workDir: string,
  plan: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
  sandbox?: SandboxOptions,
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  // Get knowledge context for the scrutinizer to verify integration points
  let knowledgeContext = "";
  try {
    const results = await search({ query: task.description, repo_id: repo.id, limit: 8 });
    if (results.length > 0) {
      const sections = results.map((r) => `### ${r.source_file} (${r.chunk_type})\n${r.content}`);
      knowledgeContext = ["## Repository Knowledge Base", ...sections].join("\n");
    }
  } catch {}

  const prompt = await renderTemplate("scrutinize", {
    repoName: repo.name,
    language: repo.language ?? undefined,
    framework: repo.framework ?? undefined,
    taskTitle: task.title,
    taskDescription: task.description,
    plan,
    knowledgeContext: knowledgeContext || undefined,
  });

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'scrutinize', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

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
    containerName: sandbox?.containerName,
    containerWorkDir: sandbox?.containerWorkDir,
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

/**
 * Run plan-again: revise the plan based on scrutiny results.
 */
export async function executePlanAgain(
  task: Task,
  repo: Repo,
  workDir: string,
  previousPlan: string,
  scrutinyResults: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
  sandbox?: SandboxOptions,
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  let knowledgeContext = "";
  try {
    const results = await search({ query: task.description, repo_id: repo.id, limit: 8 });
    if (results.length > 0) {
      const sections = results.map((r) => `### ${r.source_file} (${r.chunk_type})\n${r.content}`);
      knowledgeContext = ["## Repository Knowledge Base", ...sections].join("\n");
    }
  } catch {}

  const { getRelationshipContext } = await import("../../context-builder");
  const relationshipContext = repo.id ? getRelationshipContext(repo.id) : "";

  const prompt = await renderTemplate("plan-again", {
    repoName: repo.name,
    repoPath: repo.path,
    language: repo.language ?? undefined,
    framework: repo.framework ?? undefined,
    buildCmd: repo.build_cmd ?? undefined,
    testCmd: repo.test_cmd ?? undefined,
    lintCmd: repo.lint_cmd ?? undefined,
    description: repo.description ?? undefined,
    taskTitle: task.title,
    taskDescription: task.description,
    previousPlan,
    scrutinyResults,
    knowledgeContext: knowledgeContext || undefined,
    relationshipContext: relationshipContext || undefined,
  });

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'plan_again', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

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
    containerName: sandbox?.containerName,
    containerWorkDir: sandbox?.containerWorkDir,
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

  return { plan: result.output, error: result.error };
}

/**
 * Run finalize-plan: produce the definitive plan after final scrutiny.
 */
export async function executeFinalizePlan(
  task: Task,
  repo: Repo,
  workDir: string,
  previousPlan: string,
  scrutinyResults: string,
  mcpConfigPath?: string,
  onEvent?: (type: string, content: string) => void,
  sandbox?: SandboxOptions,
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const model = config.defaultModel;

  let knowledgeContext = "";
  try {
    const results = await search({ query: task.description, repo_id: repo.id, limit: 8 });
    if (results.length > 0) {
      const sections = results.map((r) => `### ${r.source_file} (${r.chunk_type})\n${r.content}`);
      knowledgeContext = ["## Repository Knowledge Base", ...sections].join("\n");
    }
  } catch {}

  const prompt = await renderTemplate("finalize-plan", {
    repoName: repo.name,
    repoPath: repo.path,
    language: repo.language ?? undefined,
    framework: repo.framework ?? undefined,
    buildCmd: repo.build_cmd ?? undefined,
    testCmd: repo.test_cmd ?? undefined,
    lintCmd: repo.lint_cmd ?? undefined,
    description: repo.description ?? undefined,
    taskTitle: task.title,
    taskDescription: task.description,
    previousPlan,
    scrutinyResults,
    knowledgeContext: knowledgeContext || undefined,
  });

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
     VALUES (?, ?, 'finalize_plan', 'agentic', 'running', ?, ?)`,
    [agentRunId, task.id, prompt, model]
  );

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
    containerName: sandbox?.containerName,
    containerWorkDir: sandbox?.containerWorkDir,
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

  return { plan: result.output, error: result.error };
}
