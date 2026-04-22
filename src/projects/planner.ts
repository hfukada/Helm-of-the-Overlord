import type { ProjectMilestone } from "../shared/types";

interface PlanResult {
  title: string;
  needs_clarification: boolean;
  milestones: Omit<ProjectMilestone, "index" | "task_id" | "completed">[];
}

export async function planProject(
  description: string,
  repoNames: string[],
  mcpConfigPath: string
): Promise<{ title: string; milestones: Omit<ProjectMilestone, "index" | "task_id" | "completed">[] }> {
  const { claudeJSON } = await import("../shared/claude-cli");

  const prompt = `You are a project planning assistant. Break down a software project into concrete, sequential milestone tasks.

Use the search_knowledge MCP tool to explore the relevant repositories: ${repoNames.join(", ")}.
Get a rough sense of the codebase size and structure so you can scope the work.

Project description:
${description}

Break this into sequential milestones where each milestone:
- Is a logically separate, testable set of changes
- Touches roughly 1–10 files (keeps PRs small and reviewable)
- Can be implemented and merged independently in sequence

Return ONLY valid JSON in this exact shape (no markdown, no explanation):
{
  "title": "<short project title>",
  "needs_clarification": false,
  "milestones": [
    { "title": "<milestone title>", "description": "<what to implement>", "files_estimate": <integer> }
  ]
}

Set needs_clarification to false always (reserved for future use).`;

  const claudeResult = await claudeJSON({ prompt, mcpConfigPath });

  if (claudeResult.error) {
    throw new Error(`Planning claude call failed: ${claudeResult.error}`);
  }

  let result: PlanResult;
  try {
    result = JSON.parse(claudeResult.text);
  } catch {
    const match = claudeResult.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      result = JSON.parse(match[1].trim());
    } else {
      throw new Error(`Failed to parse project plan JSON: ${claudeResult.text.slice(0, 200)}`);
    }
  }

  // needs_clarification is reserved — treat as no-op for now
  if (result.needs_clarification) {
    return { title: result.title ?? "Untitled Project", milestones: [] };
  }

  return { title: result.title, milestones: result.milestones };
}
