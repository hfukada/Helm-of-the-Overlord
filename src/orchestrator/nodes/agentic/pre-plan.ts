import { ulid } from "ulid";
import type { Task } from "../../../shared/types";
import { runClaude } from "../../subprocess";
import { buildPrePlanPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import type { SandboxOptions } from "./types";

/**
 * Runs a lightweight pre-plan phase to determine which repos need changes.
 * Returns an array of repo names that the task should target.
 */
export async function executePrePlan(
  task: Task,
  mcpConfigPath?: string,
  sandbox?: SandboxOptions,
): Promise<{ repoNames: string[]; error: string | null }> {
  const agentRunId = ulid();
  const prompt = await buildPrePlanPrompt(task);
  const model = config.defaultModel;

  const db = getDb();
  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, child_task_id)
     VALUES (?, ?, 'pre-plan', 'agentic', 'running', ?, ?, ?)`,
    [agentRunId, task.id, prompt, model, task.child_task_id ?? null]
  );

  const result = await runClaude({
    prompt,
    systemPrompt: "You are a scoping agent. Determine which repositories need changes. Be concise.",
    workDir: config.workspaceDir,
    model,
    maxTurns: 3,
    allowedTools: mcpConfigPath
      ? ["mcp__hoto__search_knowledge", "Read", "Glob"]
      : ["Read", "Glob"],
    mcpConfigPath,
    agentRunId,
    taskId: task.id,
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

  if (result.error) {
    return { repoNames: [], error: result.error };
  }

  // Parse the output -- look for "### Affected Repositories" section
  const repoNames = parseAffectedRepos(result.output);

  if (repoNames.length === 0) {
    logger.warn("Pre-plan returned no affected repos", { taskId: task.id, output: result.output });
    return { repoNames: [], error: "Pre-plan did not identify any affected repositories" };
  }

  // Validate repo names exist
  const validNames: string[] = [];
  for (const name of repoNames) {
    const exists = db.query("SELECT 1 FROM repos WHERE name = ?").get(name);
    if (exists) {
      validNames.push(name);
    } else {
      logger.warn("Pre-plan referenced unknown repo, skipping", { taskId: task.id, repoName: name });
    }
  }

  logger.info("Pre-plan determined affected repos", { taskId: task.id, repos: validNames });
  return { repoNames: validNames, error: null };
}

/**
 * Parse the pre-plan output to extract repo names from the "Affected Repositories" section.
 */
export function parseAffectedRepos(output: string): string[] {
  const names: string[] = [];

  // Find the "Affected Repositories" section
  const sectionMatch = output.match(/###\s*Affected Repositories\s*\n([\s\S]*?)(?:\n###|\n##|$)/i);
  if (!sectionMatch) {
    // Fallback: look for bullet-pointed repo names anywhere
    const bullets = output.match(/^-\s+(\S+)/gm);
    if (bullets) {
      for (const b of bullets) {
        const name = b.replace(/^-\s+/, "").replace(/:.*$/, "").replace(/\*+/g, "").trim();
        if (name && !name.includes(" ")) {
          names.push(name);
        }
      }
    }
    return names;
  }

  const section = sectionMatch[1];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    // Parse "- repo-name: reason" or "- **repo-name**: reason" or "- repo-name"
    const match = trimmed.match(/^-\s+\*{0,2}([^\s:*]+)\*{0,2}/);
    if (match) {
      names.push(match[1]);
    }
  }

  return names;
}
