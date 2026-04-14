import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildPlanPrompt, buildSystemPrompt } from "../../context-builder";
import { config } from "../../../shared/config";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  READ_EXEC_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

export interface ExecutePlanOpts {
  onEvent?: (event: AgentEvent) => void;
  promptOverride?: string;
  hasMcp?: boolean;
}

export async function executePlan(
  task: Task,
  repo: Repo,
  workDir: string,
  agent: Agent,
  opts: ExecutePlanOpts = {},
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const prompt = opts.promptOverride ?? await buildPlanPrompt(task, repo);
  const hasMcp = !!opts.hasMcp;

  const tools = hasMcp ? withKnowledgeSearch(READ_EXEC_TOOLS) : READ_EXEC_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "plan",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools,
    maxTurns: 15,
    workDir,
    model: config.defaultModel,
    onEvent: opts.onEvent,
  });

  return { plan: result.output, error: result.error };
}
