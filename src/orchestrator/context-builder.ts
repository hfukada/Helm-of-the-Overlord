import type { Repo, Task } from "../shared/types";
import { search, } from "../knowledge/search";
import { logger } from "../shared/logger";
import { renderTemplate } from "../prompts/loader";

async function getKnowledgeContext(
  query: string,
  repoId: number,
  limit: number = 8
): Promise<string> {
  try {
    const results = await search({ query, repo_id: repoId, limit });
    if (results.length === 0) return "";

    const sections = results.map((r) => {
      const header = `### ${r.source_file} (${r.chunk_type})`;
      return `${header}\n${r.content}`;
    });

    return [
      "## Repository Knowledge Base",
      "The following indexed content is relevant to this task:",
      "",
      ...sections,
    ].join("\n");
  } catch (err) {
    logger.warn("Knowledge search failed", { error: String(err) });
    return "";
  }
}

export async function getChatContext(taskId: string): Promise<string> {
  try {
    const { getDb } = await import("../knowledge/db");
    const db = getDb();
    const messages = db.query(
      "SELECT source, sender_id, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at"
    ).all(taskId) as Array<{ source: string; sender_id: string | null; content: string; created_at: string }>;
    if (messages.length === 0) return "";
    return messages.map((m) => {
      const sender = m.sender_id ?? m.source;
      return `[${sender}]: ${m.content}`;
    }).join("\n");
  } catch {
    return "";
  }
}

export async function buildPlanPrompt(task: Task, repo: Repo): Promise<string> {
  let knowledgeContext = "";
  if (repo.id) {
    knowledgeContext = await getKnowledgeContext(task.description, repo.id);
  }

  return renderTemplate("plan", {
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
    knowledgeContext: knowledgeContext || undefined,
  });
}

export async function buildImplementPrompt(
  task: Task,
  repo: Repo,
  plan: string
): Promise<string> {
  let knowledgeContext = "";
  if (repo.id) {
    knowledgeContext = await getKnowledgeContext(task.description, repo.id, 5);
  }

  const chatContext = await getChatContext(task.id);

  return renderTemplate("implement", {
    repoName: repo.name,
    language: repo.language ?? undefined,
    framework: repo.framework ?? undefined,
    taskTitle: task.title,
    taskDescription: task.description,
    knowledgeContext: knowledgeContext || undefined,
    plan,
    chatContext: chatContext || undefined,
  });
}

export function buildSystemPrompt(repo: Repo, opts?: { hasMcp?: boolean; hasDocker?: boolean }): string {
  // System prompt is synchronous in callers, so we use a sync approach
  // Template is simple enough to inline the logic here and use renderTemplate for the rest
  const lines = [`You are working on the "${repo.name}" repository.`];

  if (opts?.hasMcp) {
    lines.push("Prefer using the knowledge base MCP tools for discovery: search_knowledge to find relevant code and documentation, list_files to discover files, read_file to read indexed content.");
    lines.push("You also have Read, Glob, and Grep available for direct file access when you need to read files not covered by the knowledge base.");
  } else {
    lines.push("You have access to Read, Write, Edit, Glob, Grep, and Bash tools.");
  }

  const hasDocker = opts?.hasDocker || !!repo.docker_compose_path;
  if (hasDocker) {
    lines.push("IMPORTANT: Do NOT run build, test, lint, or typecheck commands (e.g. tsc, npm test, bun run build). The orchestrator runs these inside a Docker container after you finish. Focus only on writing code.");
  }

  lines.push("Do not run destructive commands. Do not push to git.");
  return lines.join("\n");
}
