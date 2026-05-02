import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import {
  listPullRequestReviews,
  listReviewComments,
  listPullRequestComments,
} from "../gitea/client";

export interface TaskFeedback {
  /** Inbound user messages from messaging platforms (chat course-corrections). */
  userMessages: Array<{ source: string; sender_id: string | null; content: string; created_at: string }>;
  /** Inline comments left on the diff via the hoto UI. */
  diffComments: Array<{ file_path: string; line_number: number | null; side: string; body: string }>;
  /** PR-level comments and reviews from gitea, per repo. */
  prFeedback: Array<{ repo_name: string; pr_number: number; reviews: string[]; inlineComments: string[]; generalComments: string[] }>;
  /** Final agent output captured for carry-over. */
  agentOutput: string | null;
}

/**
 * Collect everything we know about how a task went: user chat messages, diff
 * comments, gitea PR feedback, and the final agent output. Used by the project
 * revisor to decide whether to adjust upcoming milestones.
 *
 * Best-effort: any single source failing degrades to an empty list rather
 * than aborting collection.
 */
export async function collectTaskFeedback(taskId: string): Promise<TaskFeedback> {
  const db = getDb();
  const botUser = config.giteaBotUser;

  // 1. User messages on the task channel. Inbound messages from messaging
  // platforms are stored with source='human' (see messaging/manager.ts).
  const userMessages = db.query(
    `SELECT source, sender_id, content, created_at FROM task_messages
     WHERE task_id = ? AND source = 'human'
     ORDER BY created_at ASC`
  ).all(taskId) as Array<{ source: string; sender_id: string | null; content: string; created_at: string }>;

  // 2. Diff comments left via hoto UI.
  const diffComments = db.query(
    `SELECT file_path, line_number, side, body FROM diff_comments
     WHERE task_id = ?
     ORDER BY id ASC`
  ).all(taskId) as Array<{ file_path: string; line_number: number | null; side: string; body: string }>;

  // 3. PR feedback via gitea, per repo. Pull every PR for this task regardless
  // of state -- merged PRs may still carry useful reviewer commentary.
  const prRows = db.query(
    `SELECT tp.pr_number, r.name as repo_name
     FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
     WHERE tp.task_id = ?`
  ).all(taskId) as Array<{ pr_number: number; repo_name: string }>;

  const prFeedback: TaskFeedback["prFeedback"] = [];
  for (const pr of prRows) {
    try {
      const reviews = await listPullRequestReviews(pr.repo_name, pr.pr_number);
      const reviewBodies: string[] = [];
      const inline: string[] = [];
      for (const review of reviews) {
        if (review.user?.login === botUser) continue;
        if (review.body?.trim()) reviewBodies.push(review.body);
        const comments = await listReviewComments(pr.repo_name, pr.pr_number, review.id);
        for (const c of comments) {
          if (c.body?.trim()) inline.push(`[${c.path}:${c.line}] ${c.body}`);
        }
      }
      const general = await listPullRequestComments(pr.repo_name, pr.pr_number);
      const generalBodies = general
        .filter((c) => c.user.login !== botUser && c.body?.trim())
        .map((c) => c.body);

      prFeedback.push({
        repo_name: pr.repo_name,
        pr_number: pr.pr_number,
        reviews: reviewBodies,
        inlineComments: inline,
        generalComments: generalBodies,
      });
    } catch (err) {
      logger.warn("Failed to fetch PR feedback", { taskId, repo: pr.repo_name, prNumber: pr.pr_number, error: String(err) });
    }
  }

  // 4. Final agent output -- the last completed agent run for the task.
  const lastRun = db.query(
    `SELECT output FROM agent_runs WHERE task_id = ? AND status = 'completed'
     ORDER BY finished_at DESC LIMIT 1`
  ).get(taskId) as { output: string | null } | null;

  return {
    userMessages,
    diffComments,
    prFeedback,
    agentOutput: lastRun?.output ?? null,
  };
}

/**
 * Render TaskFeedback into a human-readable markdown block for inclusion in
 * an agent prompt. Returns an empty string if no feedback exists.
 */
export function renderFeedback(feedback: TaskFeedback): string {
  const sections: string[] = [];

  if (feedback.userMessages.length > 0) {
    sections.push("## User Messages on Task Channel");
    for (const m of feedback.userMessages) {
      sections.push(`- (${m.created_at}, ${m.source}) ${m.content}`);
    }
  }

  if (feedback.diffComments.length > 0) {
    sections.push("## Diff Comments");
    for (const c of feedback.diffComments) {
      const loc = c.line_number !== null ? `${c.file_path}:${c.line_number}` : c.file_path;
      sections.push(`- [${loc}] ${c.body}`);
    }
  }

  for (const pr of feedback.prFeedback) {
    const hasAny = pr.reviews.length + pr.inlineComments.length + pr.generalComments.length > 0;
    if (!hasAny) continue;
    sections.push(`## PR Feedback: ${pr.repo_name} #${pr.pr_number}`);
    for (const r of pr.reviews) sections.push(`- review: ${r}`);
    for (const c of pr.inlineComments) sections.push(`- inline: ${c}`);
    for (const c of pr.generalComments) sections.push(`- comment: ${c}`);
  }

  if (feedback.agentOutput) {
    sections.push("## Final Agent Output");
    sections.push(feedback.agentOutput.slice(0, 4000));
  }

  return sections.join("\n\n").trim();
}
