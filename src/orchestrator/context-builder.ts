import type { Repo, Task } from "../shared/types";

export function buildPlanPrompt(task: Task, repo: Repo): string {
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
  parts.push("");
  parts.push("## Instructions");
  parts.push("1. Explore the repository structure to understand the codebase.");
  parts.push("2. Identify which files need to be created or modified.");
  parts.push("3. Create a step-by-step implementation plan.");
  parts.push("4. Output the plan as a structured markdown document.");
  parts.push("");
  parts.push("Do NOT implement the changes -- only plan them.");

  return parts.join("\n");
}

export function buildImplementPrompt(
  task: Task,
  repo: Repo,
  plan: string
): string {
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
  parts.push("");
  parts.push("## Implementation Plan");
  parts.push(plan);
  parts.push("");
  parts.push("## Instructions");
  parts.push("- Implement all changes described in the plan.");
  parts.push("- Write clean, idiomatic code.");
  parts.push("- Do NOT commit changes -- just write the files.");

  return parts.join("\n");
}

export function buildSystemPrompt(repo: Repo): string {
  return [
    `You are working on the "${repo.name}" repository.`,
    "You have access to Read, Write, Edit, Glob, Grep, and Bash tools.",
    "Do not run destructive commands. Do not push to git.",
  ].join("\n");
}
