import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildSystemPrompt } from "../../context-builder";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";
import { logger } from "../../../shared/logger";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  READ_TOOLS,
  EDIT_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

export interface ExecuteFixCiOpts {
  onEvent?: (event: AgentEvent) => void;
  hasMcp?: boolean;
}

export async function executeFixCi(
  task: Task,
  repo: Repo,
  workDir: string,
  ciOutput: string,
  agent: Agent,
  opts: ExecuteFixCiOpts = {},
): Promise<{ output: string; error: string | null }> {
  const hasMcp = !!opts.hasMcp;
  const readTools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;
  const editTools = hasMcp ? withKnowledgeSearch(EDIT_TOOLS) : EDIT_TOOLS;

  // === Step 1: Plan the fix ===
  const planRunId = ulid();
  const planPrompt = await renderTemplate("fix-ci-plan", { ciOutput });

  logger.info("Planning CI fix", { taskId: task.id });

  const planResult = await runAgent(agent, planRunId, {
    nodeName: "fix_ci_plan",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt: planPrompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools: readTools,
    maxTurns: 12,
    workDir,
    addDirs: [workDir],
    model: config.defaultModel,
    onEvent: opts.onEvent,
  });

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

  // Estimate turns from the fix plan (same heuristic as implement phase)
  const fileRefs = planResult.output.match(/`[^`]+\.\w+`/g) ?? [];
  const uniqueFiles = new Set(fileRefs.map((f: string) => f.replace(/`/g, ""))).size;
  const estimatedTurns = Math.max(10, Math.min(30, 3 + Math.ceil(uniqueFiles * 2.5)));
  logger.info("Implementing CI fix", { taskId: task.id, uniqueFiles, estimatedTurns });

  const implResult = await runAgent(agent, implRunId, {
    nodeName: "fix_ci",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt: implPrompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools: editTools,
    maxTurns: estimatedTurns,
    workDir,
    addDirs: [workDir],
    model: config.defaultModel,
    onEvent: opts.onEvent,
  });

  return { output: implResult.output, error: implResult.error };
}
