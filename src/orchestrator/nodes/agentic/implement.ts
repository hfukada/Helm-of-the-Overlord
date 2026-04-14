import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildImplementPrompt } from "../../context-builder";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  EDIT_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

const MIN_TURNS = 15;
const MAX_TURNS = 50;

/**
 * Estimate the number of tool turns needed based on the plan content.
 * Heuristic: ~3 baseline + ~2.5 per unique file + ~1 per new file.
 */
function estimateTurns(plan: string): number {
  const fileRefs = plan.match(/`[^`]+\.\w+`/g) ?? [];
  const uniqueFiles = new Set(fileRefs.map((f) => f.replace(/`/g, ""))).size;
  const newFiles = (plan.match(/\(new\s*file\)|\bnew file\b|\(create\)/gi) ?? []).length;
  const estimate = 3 + Math.ceil(uniqueFiles * 2.5) + newFiles;
  const clamped = Math.max(MIN_TURNS, Math.min(MAX_TURNS, estimate));
  logger.info("Estimated implement turns", { uniqueFiles, newFiles, estimate, clamped });
  return clamped;
}

export interface ExecuteImplementOpts {
  onEvent?: (event: AgentEvent) => void;
  hasMcp?: boolean;
  /** Working directory to pass as allowed access path (typically the sandbox mount). */
  effectiveWorkDir?: string;
}

export async function executeImplement(
  task: Task,
  repos: Repo[],
  workDir: string,
  plan: string,
  agent: Agent,
  opts: ExecuteImplementOpts = {},
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const prompt = await buildImplementPrompt(task, repos, plan);
  const hasMcp = !!opts.hasMcp;
  const effectiveWorkDir = opts.effectiveWorkDir ?? workDir;

  const repoNames = repos.map((r) => r.name).join(", ");
  const systemPrompt = `You are working on: ${repoNames}. Your working directory is ${effectiveWorkDir}. ALL file paths for Write/Edit/Read MUST be absolute paths under ${effectiveWorkDir}. For example: ${effectiveWorkDir}/src/foo.ts. Do NOT create files outside of ${effectiveWorkDir} -- files outside the repo worktree will not be committed. You have access to Read, Write, Edit, Glob, Grep, and Bash tools. Do not run destructive commands. Do not push to git.`;

  const tools = hasMcp ? withKnowledgeSearch(EDIT_TOOLS) : EDIT_TOOLS;
  const maxTurns = estimateTurns(plan);

  const result = await runAgent(agent, agentRunId, {
    nodeName: "implement",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt,
    tools,
    maxTurns,
    workDir,
    addDirs: [effectiveWorkDir],
    model: config.defaultModel,
    onEvent: opts.onEvent,
  });

  return { output: result.output, error: result.error };
}
