import { ulid } from "ulid";
import type { Task, Repo } from "../../../shared/types";
import { buildSystemPrompt } from "../../context-builder";
import { renderTemplate } from "../../../prompts/loader";
import { getDb } from "../../../knowledge/db";
import { config } from "../../../shared/config";
import { search } from "../../../knowledge/search";
import { logger } from "../../../shared/logger";
import {
  type Agent,
  type AgentEvent,
  runAgent,
  READ_TOOLS,
  withKnowledgeSearch,
} from "../../../agent";

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

export interface ExecuteReviewFeedbackOpts {
  onEvent?: (event: AgentEvent) => void;
  hasMcp?: boolean;
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
  agent: Agent,
  opts: ExecuteReviewFeedbackOpts = {},
): Promise<{ verdict: "small" | "large"; output: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const prompt = await renderTemplate("understand-review", {
    taskDescription: task.description,
    previousPlan,
    feedback,
  });

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "understand_review",
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

  if (result.error) {
    return { verdict: "large", output: result.output, error: result.error };
  }

  const verdictMatch = result.output.match(/VERDICT:\s*(SMALL|LARGE)/i);
  const verdict = verdictMatch?.[1]?.toLowerCase() === "small" ? "small" : "large";

  logger.info("Review feedback triaged", { taskId: task.id, verdict });
  return { verdict, output: result.output, error: null };
}

/**
 * Plan targeted fixes for small review feedback.
 */
export async function executeReviewSmallFeedback(
  task: Task,
  repo: Repo,
  workDir: string,
  feedback: string,
  previousPlan: string,
  agent: Agent,
  opts: ExecuteReviewFeedbackOpts = {},
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const prompt = await renderTemplate("review-small-feedback", {
    taskDescription: task.description,
    previousPlan,
    feedback,
  });

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "review_small_feedback",
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

  return { plan: result.output, error: result.error };
}

/**
 * Plan structural changes for large review feedback.
 */
export async function executeReviewLargeFeedback(
  task: Task,
  repo: Repo,
  workDir: string,
  feedback: string,
  previousPlan: string,
  agent: Agent,
  opts: ExecuteReviewFeedbackOpts = {},
): Promise<{ plan: string; error: string | null }> {
  const agentRunId = ulid();
  const hasMcp = !!opts.hasMcp;

  const knowledgeContext = repo.id ? await getKnowledgeContext(task.description, repo.id) : "";
  const chatContext = getChatContext(task.id);

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

  const tools = hasMcp ? withKnowledgeSearch(READ_TOOLS) : READ_TOOLS;

  const result = await runAgent(agent, agentRunId, {
    nodeName: "review_large_feedback",
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

  return { plan: result.output, error: result.error };
}
