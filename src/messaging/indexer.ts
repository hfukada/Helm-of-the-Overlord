import { getDb } from "../knowledge/db";
import { indexChatHistory } from "../knowledge/indexer";
import { logger } from "../shared/logger";
import type { Repo } from "../shared/types";

export async function indexTaskChatHistory(taskId: string): Promise<void> {
  const db = getDb();

  const messages = db.query(
    "SELECT source, sender_id, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at"
  ).all(taskId) as Array<{ source: string; sender_id: string | null; content: string; created_at: string }>;

  if (messages.length === 0) return;

  // Get the repo for this task
  const taskRow = db.query(
    "SELECT repo_id FROM tasks WHERE id = ?"
  ).get(taskId) as { repo_id: number | null } | null;

  if (!taskRow?.repo_id) return;

  const repoRow = db.query(
    "SELECT * FROM repos WHERE id = ?"
  ).get(taskRow.repo_id) as Record<string, unknown> | null;

  if (!repoRow) return;

  const repo: Repo = {
    id: repoRow.id as number,
    name: repoRow.name as string,
    path: repoRow.path as string,
    description: repoRow.description as string | null,
    build_cmd: repoRow.build_cmd as string | null,
    test_cmd: repoRow.test_cmd as string | null,
    run_cmd: repoRow.run_cmd as string | null,
    lint_cmd: repoRow.lint_cmd as string | null,
    language: repoRow.language as string | null,
    framework: repoRow.framework as string | null,
    docker_compose_path: repoRow.docker_compose_path as string | null,
    metadata: null,
  };

  const content = messages.map((m) => {
    const sender = m.sender_id ?? m.source;
    return `[${m.created_at}] ${sender}: ${m.content}`;
  }).join("\n");

  try {
    await indexChatHistory(repo, taskId, content);
    logger.info("Indexed chat history for task", { taskId, messageCount: messages.length });
  } catch (err) {
    logger.warn("Failed to index chat history", { taskId, error: String(err) });
  }
}
