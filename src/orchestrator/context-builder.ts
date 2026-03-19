import type { Repo, Task } from "../shared/types";
import { search, } from "../knowledge/search";
import { logger } from "../shared/logger";

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

export async function buildPlanPrompt(task: Task, repo: Repo): Promise<string> {
  const parts = [
    "You are a planning agent. Your job is to create a detailed implementation plan for the following task.",
    "",
    `## Repository: ${repo.name}`,
    `Path: ${repo.path}`,
  ];

  if (repo.language) parts.push(`Language: ${repo.language}`);
  if (repo.framework) parts.push(`Framework: ${repo.framework}`);
  if (repo.build_cmd) parts.push(`Build command: ${repo.build_cmd}`);
  if (repo.test_cmd) parts.push(`Test command: ${repo.test_cmd}`);
  if (repo.lint_cmd) parts.push(`Lint command: ${repo.lint_cmd}`);
  if (repo.description) parts.push(`Description: ${repo.description}`);

  parts.push("");
  parts.push("## Task");
  parts.push(`Title: ${task.title}`);
  parts.push(`Description: ${task.description}`);

  // Include knowledge context
  if (repo.id) {
    const knowledge = await getKnowledgeContext(task.description, repo.id);
    if (knowledge) {
      parts.push("");
      parts.push(knowledge);
    }
  }

  parts.push("");
  parts.push("## Instructions");
  parts.push("1. Use the repository knowledge above to understand the codebase structure, conventions, and patterns.");
  parts.push("2. Only read files if the knowledge base does not cover what you need.");
  parts.push("3. Identify which files need to be created or modified.");
  parts.push("4. Create a step-by-step implementation plan.");
  parts.push("5. Output the plan as a structured markdown document.");
  parts.push("");
  parts.push("Do NOT implement the changes -- only plan them.");

  return parts.join("\n");
}

export async function buildImplementPrompt(
  task: Task,
  repo: Repo,
  plan: string
): Promise<string> {
  const parts = [
    "You are an implementation agent. Implement the following plan exactly.",
    "",
    `## Repository: ${repo.name}`,
  ];

  if (repo.language) parts.push(`Language: ${repo.language}`);
  if (repo.framework) parts.push(`Framework: ${repo.framework}`);

  parts.push("");
  parts.push("## Task");
  parts.push(`Title: ${task.title}`);
  parts.push(`Description: ${task.description}`);

  // Include knowledge context
  if (repo.id) {
    const knowledge = await getKnowledgeContext(task.description, repo.id, 5);
    if (knowledge) {
      parts.push("");
      parts.push(knowledge);
    }
  }

  parts.push("");
  parts.push("## Implementation Plan");
  parts.push(plan);
  parts.push("");
  parts.push("## Instructions");
  parts.push("- Use the repository knowledge above to understand existing patterns and conventions.");
  parts.push("- Implement all changes described in the plan.");
  parts.push("- Write clean, idiomatic code that matches the existing style.");
  parts.push("- Do NOT commit changes -- just write the files.");

  return parts.join("\n");
}

export function buildSystemPrompt(repo: Repo, opts?: { hasMcp?: boolean; hasDocker?: boolean }): string {
  const lines = [`You are working on the "${repo.name}" repository.`];

  if (opts?.hasMcp) {
    lines.push("Prefer using the knowledge base MCP tools for discovery: search_knowledge to find relevant code and documentation, list_files to discover files, read_file to read indexed content.");
    lines.push("You also have Read, Glob, and Grep available for direct file access when you need to read files not covered by the knowledge base.");
  } else {
    lines.push("You have access to Read, Write, Edit, Glob, Grep, and Bash tools.");
  }

  if (opts?.hasDocker) {
    lines.push("Build, test, and lint commands run inside a Docker container. Focus on writing code -- the orchestrator handles running commands.");
  }

  lines.push("Do not run destructive commands. Do not push to git.");
  return lines.join("\n");
}
