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
  parts.push("4. Produce a structured execution plan as described below.");
  parts.push("");
  parts.push("Do NOT implement the changes -- only plan them.");
  parts.push("");
  parts.push("## Output Format");
  parts.push("");
  parts.push("Your output MUST follow this exact structure:");
  parts.push("");
  parts.push("### Summary");
  parts.push("A brief (1-3 sentence) description of the overall approach.");
  parts.push("");
  parts.push("### Files to Modify");
  parts.push("List each file that will be created or modified, with a short note on what changes.");
  parts.push("");
  parts.push("### Execution Plan");
  parts.push("A numbered checklist of concrete implementation steps. Each step should be a single, actionable unit of work (e.g. 'Add field X to interface Y in file Z', not 'update the types'). Steps should be ordered so each builds on the previous.");
  parts.push("");
  parts.push("After code changes routinely:");
  parts.push("- [ ] Run lint and verify no errors");
  parts.push("- [ ] Run tests and verify they pass");
  parts.push("");
  parts.push("This ensures the implementation agent leaves the codebase in a stable state.");

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
  parts.push("- Follow the Execution Plan checklist above step by step, in order.");
  parts.push("- Use the repository knowledge above to understand existing patterns and conventions.");
  parts.push("- Write clean, idiomatic code that matches the existing style.");
  parts.push("- Do a final check to see if you can generalize things or hook into existing patterns");
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

  // Detect Docker from repo config or explicit flag
  const hasDocker = opts?.hasDocker || !!repo.docker_compose_path;
  if (hasDocker) {
    lines.push("IMPORTANT: Do NOT run build, test, lint, or typecheck commands (e.g. tsc, npm test, bun run build). The orchestrator runs these inside a Docker container after you finish. Focus only on writing code.");
  }

  lines.push("Do not run destructive commands. Do not push to git.");
  return lines.join("\n");
}
