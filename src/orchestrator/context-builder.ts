import type { Repo, Task } from "../shared/types";
import { search, } from "../knowledge/search";
import { logger } from "../shared/logger";
import { renderTemplate } from "../prompts/loader";
import { buildRepoMap } from "../treesitter/repo-map";

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

export function getRelationshipContext(repoId: number): string {
  try {
    const { getDb } = require("../knowledge/db") as { getDb: typeof import("../knowledge/db").getDb };
    const db = getDb();
    const rows = db.query(
      `SELECT rr.relationship, rr.description, s.name as source_name, t.name as target_name
       FROM repo_relationships rr
       JOIN repos s ON s.id = rr.source_repo_id
       JOIN repos t ON t.id = rr.target_repo_id
       WHERE rr.source_repo_id = ? OR rr.target_repo_id = ?
       ORDER BY s.name, t.name`
    ).all(repoId, repoId) as Array<{
      relationship: string;
      description: string | null;
      source_name: string;
      target_name: string;
    }>;

    if (rows.length === 0) return "";

    const lines = rows.map((r) => {
      const desc = r.description ? `: ${r.description}` : "";
      return `- ${r.source_name} -> ${r.target_name} (${r.relationship})${desc}`;
    });

    return [
      "## Related Repositories",
      "This repo has the following relationships with other repos. Consider these when planning -- changes may need to span multiple repos.",
      "",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

export async function buildPrePlanPrompt(task: Task): Promise<string> {
  const { getDb } = require("../knowledge/db") as { getDb: typeof import("../knowledge/db").getDb };
  const db = getDb();

  // List all repos with metadata
  const repos = db.query(
    "SELECT id, name, path, description, language, framework FROM repos WHERE archived = 0 ORDER BY name"
  ).all() as Array<{
    id: number;
    name: string;
    path: string;
    description: string | null;
    language: string | null;
    framework: string | null;
  }>;

  const repoLines = repos.map((r) => {
    const parts = [`- **${r.name}**`];
    if (r.language) parts.push(`(${r.language})`);
    if (r.framework) parts.push(`[${r.framework}]`);
    if (r.description) parts.push(`-- ${r.description}`);
    return parts.join(" ");
  });
  const repoList = repoLines.join("\n");

  // Aggregate relationship context across all repos
  const allRelationships = db.query(
    `SELECT rr.relationship, rr.description, s.name as source_name, t.name as target_name
     FROM repo_relationships rr
     JOIN repos s ON s.id = rr.source_repo_id
     JOIN repos t ON t.id = rr.target_repo_id
     ORDER BY s.name, t.name`
  ).all() as Array<{
    relationship: string;
    description: string | null;
    source_name: string;
    target_name: string;
  }>;

  let relationshipContext = "";
  if (allRelationships.length > 0) {
    const lines = allRelationships.map((r) => {
      const desc = r.description ? `: ${r.description}` : "";
      return `- ${r.source_name} -> ${r.target_name} (${r.relationship})${desc}`;
    });
    relationshipContext = [
      "## Repository Relationships",
      ...lines,
    ].join("\n");
  }

  // Search knowledge across ALL repos (no repo_id filter)
  let knowledgeContext = "";
  try {
    const results = await search({ query: task.description, limit: 12 });
    if (results.length > 0) {
      const sections = results.map((r) => {
        return `### [${r.repo_name}] ${r.source_file} (${r.chunk_type})\n${r.content}`;
      });
      knowledgeContext = [
        "## Knowledge Base (cross-repo search)",
        "The following indexed content from across all repos is relevant:",
        "",
        ...sections,
      ].join("\n");
    }
  } catch (err) {
    logger.warn("Cross-repo knowledge search failed", { error: String(err) });
  }

  // Generate tree-sitter repo maps for all repos (lower budget per repo)
  const mapSections: string[] = [];
  for (const repo of repos) {
    try {
      const map = await buildRepoMap({ repoPath: repo.path, maxTokens: 1000 });
      if (map) {
        mapSections.push(`### [${repo.name}] Code Structure\n${map}`);
      }
    } catch (err) {
      logger.warn("Repo map generation failed for pre-plan", { repo: repo.name, error: String(err) });
    }
  }
  const repoMapContext = mapSections.length > 0 ? mapSections.join("\n\n") : "";

  return renderTemplate("pre-plan", {
    repoList,
    relationshipContext: relationshipContext || undefined,
    knowledgeContext: knowledgeContext || undefined,
    repoMapContext: repoMapContext || undefined,
    taskTitle: task.title,
    taskDescription: task.description,
  });
}

export function buildRepoList(repos: Repo[]): string {
  return repos.map((r) => {
    let line = `- **${r.name}**`;
    if (r.language) line += ` | ${r.language}`;
    if (r.framework) line += ` [${r.framework}]`;
    if (r.lint_cmd) line += ` | lint: \`${r.lint_cmd}\``;
    if (r.test_cmd) line += ` | test: \`${r.test_cmd}\``;
    return line;
  }).join("\n");
}

export async function buildPlanPrompt(task: Task, repos: Repo | Repo[]): Promise<string> {
  const reposArray = Array.isArray(repos) ? repos : [repos];
  const repoList = buildRepoList(reposArray);

  // Aggregate knowledge from all repos
  const knowledgeSections: string[] = [];
  for (const repo of reposArray) {
    if (!repo.id) continue;
    try {
      const results = await search({ query: task.description, repo_id: repo.id, limit: 6 });
      for (const r of results) {
        knowledgeSections.push(`### [${r.repo_name}] ${r.source_file} (${r.chunk_type})\n${r.content}`);
      }
    } catch {}
  }

  let knowledgeContext = "";
  if (knowledgeSections.length > 0) {
    knowledgeContext = ["## Repository Knowledge Base", "", ...knowledgeSections].join("\n");
  }

  // Aggregate relationships (deduplicated)
  const relSections: string[] = [];
  for (const repo of reposArray) {
    if (!repo.id) continue;
    const ctx = getRelationshipContext(repo.id);
    if (ctx) relSections.push(ctx);
  }
  const relationshipContext = relSections.length > 0
    ? [...new Set(relSections)].join("\n")
    : "";

  // Generate tree-sitter repo maps
  const mapSections: string[] = [];
  for (const repo of reposArray) {
    try {
      const map = await buildRepoMap({ repoPath: repo.path, maxTokens: 2000 });
      if (map) {
        mapSections.push(`### [${repo.name}] Code Structure\n${map}`);
      }
    } catch (err) {
      logger.warn("Repo map generation failed for plan", { repo: repo.name, error: String(err) });
    }
  }
  const repoMapContext = mapSections.length > 0 ? mapSections.join("\n\n") : "";

  return renderTemplate("plan", {
    repoList,
    taskDescription: task.description,
    knowledgeContext: knowledgeContext || undefined,
    relationshipContext: relationshipContext || undefined,
    repoMapContext: repoMapContext || undefined,
  });
}

export async function buildRevisionPlanPrompt(
  task: Task,
  repo: Repo,
  feedback: string,
  previousPlan: string,
): Promise<string> {
  let knowledgeContext = "";
  if (repo.id) {
    knowledgeContext = await getKnowledgeContext(task.description, repo.id);
  }

  const chatContext = await getChatContext(task.id);

  // Get lint/CI status from the DB
  const { getDb } = await import("../knowledge/db");
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

  // Only include output if it failed (no need to show passing output)
  const lintErrors = lintPassed === 0 && row?.lint_output
    ? row.lint_output.slice(0, 3000) : undefined;
  const ciErrors = ciPassed === 0 && row?.ci_output
    ? row.ci_output.slice(0, 3000) : undefined;

  const relationshipContext = repo.id ? getRelationshipContext(repo.id) : "";

  return renderTemplate("plan-revise", {
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
    feedback,
    chatContext: chatContext || undefined,
    lintStatus: lintPassed !== null ? (lintPassed ? "passed" : "failed") : undefined,
    lintErrors,
    ciStatus: ciPassed !== null ? (ciPassed ? "passed" : "failed") : undefined,
    ciErrors,
    knowledgeContext: knowledgeContext || undefined,
    relationshipContext: relationshipContext || undefined,
  });
}

export async function buildImplementPrompt(
  task: Task,
  repos: Repo | Repo[],
  plan: string
): Promise<string> {
  const reposArray = Array.isArray(repos) ? repos : [repos];
  const repoLines = reposArray.map((r) => {
    let line = `- **./${r.name}/** -- ${r.language ?? "unknown"}`;
    if (r.framework) line += ` (${r.framework})`;
    return line;
  });
  const repoList = repoLines.join("\n");

  const knowledgeSections: string[] = [];
  for (const repo of reposArray) {
    if (!repo.id) continue;
    try {
      const results = await search({ query: task.description, repo_id: repo.id, limit: 5 });
      for (const r of results) {
        knowledgeSections.push(`### [${r.repo_name}] ${r.source_file} (${r.chunk_type})\n${r.content}`);
      }
    } catch {}
  }

  let knowledgeContext = "";
  if (knowledgeSections.length > 0) {
    knowledgeContext = ["## Repository Knowledge Base", ...knowledgeSections].join("\n");
  }

  const chatContext = await getChatContext(task.id);

  const primaryRepo = reposArray[0];
  return renderTemplate("implement", {
    repoList,
    taskTitle: task.title,
    taskDescription: task.description,
    repoName: primaryRepo?.name ?? "",
    repoLanguage: primaryRepo?.language ?? undefined,
    repoFramework: primaryRepo?.framework ?? undefined,
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
    lines.push("You have these tools: Read, Glob, Grep (direct file access), and search_knowledge (MCP knowledge base search).");
    lines.push("START by calling search_knowledge to find relevant indexed documentation and code patterns. This is faster than reading files one by one.");
    lines.push("Then use Read/Glob/Grep for specific files you need to examine in detail.");
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
