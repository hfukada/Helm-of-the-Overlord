import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildSystemPrompt } from "../../context-builder";
import { config } from "../../../shared/config";
import { renderTemplate } from "../../../prompts/loader";
import { search } from "../../../knowledge/search";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  READ_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

export interface ExecuteScrutinyOpts {
  onEvent?: (event: AgentEvent) => void;
  hasMcp?: boolean;
}

async function getKnowledgeContext(taskDescription: string, repoId: number): Promise<string> {
  try {
    const results = await search({ query: taskDescription, repo_id: repoId, limit: 8 });
    if (results.length > 0) {
      const sections = results.map((r) => `### ${r.source_file} (${r.chunk_type})\n${r.content}`);
      return ["## Repository Knowledge Base", ...sections].join("\n");
    }
  } catch {}
  return "";
}

/**
 * Run the scrutinize phase: review a plan against the checklist.
 */
export async function executeScrutinize(
  task: Task,
  repo: Repo,
  workDir: string,
  plan: string,
  agent: Agent,
  opts: ExecuteScrutinyOpts = {},
): Promise<{ output: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const knowledgeContext = await getKnowledgeContext(task.description, repo.id);

  const prompt = await renderTemplate("scrutinize", {
    repoName: repo.name,
    language: repo.language ?? undefined,
    framework: repo.framework ?? undefined,
    taskTitle: task.title,
    taskDescription: task.description,
    plan,
    knowledgeContext: knowledgeContext || undefined,
  });

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "scrutinize",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools,
    maxTurns: 10,
    workDir,
    model: config.defaultModel,
    repoName: repo.name,
    onEvent: opts.onEvent,
  });

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
  agent: Agent,
  opts: ExecuteScrutinyOpts = {},
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const knowledgeContext = await getKnowledgeContext(task.description, repo.id);

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

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "plan_again",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools,
    maxTurns: 10,
    workDir,
    model: config.defaultModel,
    repoName: repo.name,
    onEvent: opts.onEvent,
  });

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
  agent: Agent,
  opts: ExecuteScrutinyOpts = {},
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const knowledgeContext = await getKnowledgeContext(task.description, repo.id);

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

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "finalize_plan",
    taskId: task.id,
    childTaskId: task.child_task_id,
    prompt,
    systemPrompt: buildSystemPrompt(repo, { hasMcp }),
    tools,
    maxTurns: 10,
    workDir,
    model: config.defaultModel,
    repoName: repo.name,
    onEvent: opts.onEvent,
  });

  return { plan: result.output, error: result.error };
}
