import { ulid } from "ulid";
import type { Task } from "../../../shared/types";
import { buildPrePlanPrompt } from "../../context-builder";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import {
  type Agent,
  runAgent,
  READ,
  GLOB,
  withKnowledgeSearch,
} from "../../../agent";

/**
 * Runs a lightweight pre-plan phase to determine which repos need changes.
 * Returns an array of repo names that the task should target.
 */
export async function executePrePlan(
  task: Task,
  agent: Agent,
  opts: { hasMcp?: boolean } = {},
): Promise<{ repoNames: string[]; error: string | null }> {
  const agentRunId = ulid();
  const prompt = await buildPrePlanPrompt(task);
  const hasMcp = !!opts.hasMcp;

  const baseTools = [READ, GLOB];
  const tools = hasMcp ? withKnowledgeSearch(baseTools) : baseTools;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "pre-plan",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: "You are a scoping agent. Determine which repositories need changes. Be concise.",
    tools,
    maxTurns: 3,
    workDir: config.workspaceDir,
    model: config.defaultModel,
  });

  if (result.error) {
    return { repoNames: [], error: result.error };
  }

  const repoNames = parseAffectedRepos(result.output);

  if (repoNames.length === 0) {
    logger.warn("Pre-plan returned no affected repos", { taskId: task.id, output: result.output });
    return { repoNames: [], error: "Pre-plan did not identify any affected repositories" };
  }

  // Validate repo names exist
  const db = getDb();
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
