import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildSystemPrompt, getChatContext } from "../../context-builder";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  EDIT_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

export interface ExecuteFixLintOpts {
  onEvent?: (event: AgentEvent) => void;
  hasMcp?: boolean;
}

export async function executeFixLint(
  task: Task,
  repo: Repo,
  workDir: string,
  lintOutput: string,
  lintCommand: string,
  agent: Agent,
  opts: ExecuteFixLintOpts = {},
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const chatContext = await getChatContext(task.id);

  const prompt = await renderTemplate("fix-lint", {
    repoName: repo.name,
    lintCommand,
    lintOutput,
    chatContext: chatContext || undefined,
  });

  const tools = hasMcp ? withKnowledgeSearch(EDIT_TOOLS) : EDIT_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "fix_lint",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools,
    maxTurns: 10,
    workDir,
    model: config.defaultModel,
    onEvent: opts.onEvent,
  });

  return { output: result.output, error: result.error };
}
