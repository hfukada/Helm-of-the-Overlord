import {
  getPullRequest,
  listPullRequestReviews,
  listReviewComments,
  listPullRequestComments,
  commentOnPullRequest,
  isGiteaConfigured,
} from "./client";
import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import { reviseTask } from "../orchestrator/task-runner";

interface PollerState {
  taskId: string;
  repoName: string;
  repoPath: string;
  branchName: string;
  prNumber: number;
  repoId: number;
  timer: ReturnType<typeof setInterval> | null;
}

// Key: "${taskId}:${repoName}"
const activePollers = new Map<string, PollerState>();

function pollerKey(taskId: string, repoName: string): string {
  return `${taskId}:${repoName}`;
}

function loadCursors(taskId: string, repoId: number): { lastReviewId: number; lastCommentId: number } {
  const db = getDb();
  const row = db.query(
    "SELECT last_review_id, last_comment_id FROM task_prs WHERE task_id = ? AND repo_id = ?"
  ).get(taskId, repoId) as { last_review_id: number; last_comment_id: number } | null;
  return {
    lastReviewId: row?.last_review_id ?? 0,
    lastCommentId: row?.last_comment_id ?? 0,
  };
}

function saveCursors(taskId: string, repoId: number, lastReviewId: number, lastCommentId: number): void {
  const db = getDb();
  db.run(
    "UPDATE task_prs SET last_review_id = ?, last_comment_id = ? WHERE task_id = ? AND repo_id = ?",
    [lastReviewId, lastCommentId, taskId, repoId]
  );
}

export async function seedCursors(
  taskId: string,
  repoName: string,
  prNumber: number
): Promise<void> {
  let lastReviewId = 0;
  let lastCommentId = 0;
  try {
    const reviews = await listPullRequestReviews(repoName, prNumber);
    if (reviews.length > 0) {
      lastReviewId = Math.max(...reviews.map((r) => r.id));
    }
    const comments = await listPullRequestComments(repoName, prNumber);
    if (comments.length > 0) {
      lastCommentId = Math.max(...comments.map((c) => c.id));
    }
  } catch (err) {
    logger.warn("Failed to seed poller cursors from Gitea", { taskId, error: String(err) });
    return;
  }

  // Save to task_prs
  const db = getDb();
  db.run(
    "UPDATE task_prs SET last_review_id = ?, last_comment_id = ? WHERE task_id = ? AND pr_number = ?",
    [lastReviewId, lastCommentId, taskId, prNumber]
  );
}

export function startReviewPoller(
  taskId: string,
  repoName: string,
  repoPath: string,
  branchName: string,
  prNumber: number
): void {
  const key = pollerKey(taskId, repoName);

  // Stop existing poller for this task+repo
  const existing = activePollers.get(key);
  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  // Look up repo_id from task_prs
  const db = getDb();
  const prRow = db.query(
    "SELECT repo_id FROM task_prs WHERE task_id = ? AND pr_number = ?"
  ).get(taskId, prNumber) as { repo_id: number } | null;
  const repoId = prRow?.repo_id ?? 0;

  const state: PollerState = {
    taskId,
    repoName,
    repoPath,
    branchName,
    prNumber,
    repoId,
    timer: null,
  };

  state.timer = setInterval(() => {
    pollPR(state).catch((err) => {
      logger.warn("PR poll failed", { taskId, repoName, prNumber, error: String(err) });
    });
  }, config.giteaPollIntervalMs);

  activePollers.set(key, state);

  const { lastReviewId, lastCommentId } = loadCursors(taskId, repoId);
  logger.info("Started review poller", { taskId, repoName, prNumber, lastReviewId, lastCommentId });
}

/** Stop all pollers for a task. */
export function stopTaskPollers(taskId: string): void {
  for (const [key, state] of activePollers) {
    if (state.taskId === taskId) {
      if (state.timer) clearInterval(state.timer);
      activePollers.delete(key);
    }
  }
}

/** Stop a single poller for a task+repo. */
export function stopReviewPoller(taskId: string, repoName?: string): void {
  if (repoName) {
    const key = pollerKey(taskId, repoName);
    const state = activePollers.get(key);
    if (state?.timer) clearInterval(state.timer);
    activePollers.delete(key);
  } else {
    stopTaskPollers(taskId);
  }
}

/** Check if all PRs for a task are merged. */
function areAllPrsMerged(taskId: string): boolean {
  const db = getDb();
  const row = db.query(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) as merged FROM task_prs WHERE task_id = ?"
  ).get(taskId) as { total: number; merged: number };
  return row.total > 0 && row.total === row.merged;
}

/** Aggregate feedback from all PRs for a task that have new rejections. */
async function aggregateFeedbackForTask(taskId: string): Promise<string> {
  const db = getDb();
  const prs = db.query(
    `SELECT tp.repo_id, tp.pr_number, tp.last_review_id, tp.last_comment_id, r.name as repo_name
     FROM task_prs tp
     JOIN repos r ON r.id = tp.repo_id
     WHERE tp.task_id = ? AND tp.status = 'open'`
  ).all(taskId) as Array<{
    repo_id: number;
    pr_number: number;
    last_review_id: number;
    last_comment_id: number;
    repo_name: string;
  }>;

  const feedbackParts: string[] = [];
  const botUser = config.giteaBotUser;

  for (const pr of prs) {
    const reviews = await listPullRequestReviews(pr.repo_name, pr.pr_number);
    const newReviews = reviews.filter((r) => r.id > pr.last_review_id);

    const changeRequests = newReviews.filter(
      (r) => r.state.toLowerCase() === "request_changes" || r.state.toLowerCase() === "rejected"
    );

    if (changeRequests.length > 0) {
      feedbackParts.push(`## Feedback for ${pr.repo_name} (PR #${pr.pr_number})`);

      for (const review of changeRequests) {
        if (review.body?.trim()) {
          feedbackParts.push(review.body);
        }
        const inlineComments = await listReviewComments(pr.repo_name, pr.pr_number, review.id);
        for (const c of inlineComments) {
          if (c.body?.trim()) {
            feedbackParts.push(`[${c.path}:${c.line}] ${c.body}`);
          }
        }
      }
    }

    // General PR comments
    const comments = await listPullRequestComments(pr.repo_name, pr.pr_number);
    const newComments = comments.filter(
      (c) => c.id > pr.last_comment_id && c.user.login !== botUser
    );
    for (const c of newComments) {
      if (c.body?.trim()) {
        feedbackParts.push(c.body);
      }
    }

    // Update cursors
    let maxReviewId = pr.last_review_id;
    let maxCommentId = pr.last_comment_id;
    if (newReviews.length > 0) maxReviewId = Math.max(...newReviews.map((r) => r.id));
    if (newComments.length > 0) maxCommentId = Math.max(...newComments.map((c) => c.id));
    saveCursors(taskId, pr.repo_id, maxReviewId, maxCommentId);
  }

  return feedbackParts.join("\n\n").trim() || "Changes requested (no specific feedback provided).";
}

async function pollPR(state: PollerState): Promise<void> {
  const { taskId, repoName, repoId, prNumber } = state;
  let { lastReviewId, lastCommentId } = loadCursors(taskId, repoId);

  const pr = await getPullRequest(repoName, prNumber);

  // Check if PR was merged
  if (pr.merged) {
    logger.info("PR merged", { taskId, repoName, prNumber });
    stopReviewPoller(taskId, repoName);

    // Update task_prs status
    const db = getDb();
    db.run(
      "UPDATE task_prs SET status = 'merged' WHERE task_id = ? AND repo_id = ?",
      [taskId, repoId]
    );

    // Check if ALL PRs for this task are merged
    if (areAllPrsMerged(taskId)) {
      logger.info("All PRs merged, marking task committed", { taskId });
      stopTaskPollers(taskId);
      const now = new Date().toISOString();
      db.run("UPDATE tasks SET status = 'committed', updated_at = ? WHERE id = ?", [now, taskId]);
    }
    return;
  }

  // Check if PR was closed without merge
  if (pr.state === "closed") {
    logger.info("PR closed without merge", { taskId, repoName, prNumber });
    stopTaskPollers(taskId);

    const db = getDb();
    db.run("UPDATE task_prs SET status = 'closed' WHERE task_id = ? AND repo_id = ?", [taskId, repoId]);
    const now = new Date().toISOString();
    db.run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, taskId]);
    return;
  }

  // Check for new reviews
  const reviews = await listPullRequestReviews(repoName, prNumber);
  const newReviews = reviews.filter((r) => r.id > lastReviewId);

  if (newReviews.length > 0) {
    lastReviewId = Math.max(...newReviews.map((r) => r.id));
    logger.info("New reviews detected", { taskId, repoName, count: newReviews.length, states: newReviews.map((r) => r.state) });
  }

  const changeRequests = newReviews.filter(
    (r) => r.state.toLowerCase() === "request_changes" || r.state.toLowerCase() === "rejected"
  );

  if (changeRequests.length > 0) {
    logger.info("Review changes requested, starting revision", { taskId, repoName, prNumber });

    // Stop ALL pollers for this task (revision affects all repos)
    stopTaskPollers(taskId);

    // Aggregate feedback from ALL PRs for this task
    const feedback = await aggregateFeedbackForTask(taskId);

    try {
      await reviseTask(taskId, feedback);

      // Comment on all open PRs
      const db = getDb();
      const openPrs = db.query(
        `SELECT tp.pr_number, r.name as repo_name
         FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
         WHERE tp.task_id = ? AND tp.status = 'open'`
      ).all(taskId) as Array<{ pr_number: number; repo_name: string }>;

      for (const opr of openPrs) {
        await commentOnPullRequest(opr.repo_name, opr.pr_number, "Revision complete based on review feedback. Please re-review.").catch(() => {});
      }

      // Seed cursors and restart pollers for all open PRs
      for (const opr of openPrs) {
        await seedCursors(taskId, opr.repo_name, opr.pr_number);
        const pollerState = findPollerInfo(taskId, opr.repo_name);
        if (pollerState) {
          startReviewPoller(taskId, opr.repo_name, pollerState.repoPath, pollerState.branchName, opr.pr_number);
        }
      }
    } catch (err) {
      logger.error("Revision after review failed", { taskId, error: String(err) });
      // Comment on the triggering PR
      await commentOnPullRequest(repoName, prNumber, `Revision failed: ${err}`).catch(() => {});
      // Restart pollers so we keep watching
      restartPollersForTask(taskId);
    }
    return;
  }

  // Track comment IDs
  const comments = await listPullRequestComments(repoName, prNumber);
  const botUser = config.giteaBotUser;
  const newComments = comments.filter(
    (c) => c.id > lastCommentId && c.user.login !== botUser
  );
  if (newComments.length > 0) {
    lastCommentId = Math.max(...newComments.map((c) => c.id));
  }

  saveCursors(taskId, repoId, lastReviewId, lastCommentId);
}

/** Find stored poller info for restarting. */
function findPollerInfo(taskId: string, repoName: string): { repoPath: string; branchName: string } | null {
  const db = getDb();
  const row = db.query(
    `SELECT r.path as repo_path, t.branch_name
     FROM task_prs tp
     JOIN repos r ON r.id = tp.repo_id
     JOIN tasks t ON t.id = tp.task_id
     WHERE tp.task_id = ? AND r.name = ?`
  ).get(taskId, repoName) as { repo_path: string; branch_name: string } | null;
  if (!row) return null;
  return { repoPath: row.repo_path, branchName: row.branch_name };
}

/** Restart pollers for all open PRs of a task. */
function restartPollersForTask(taskId: string): void {
  const db = getDb();
  const prs = db.query(
    `SELECT tp.pr_number, r.name as repo_name, r.path as repo_path, t.branch_name
     FROM task_prs tp
     JOIN repos r ON r.id = tp.repo_id
     JOIN tasks t ON t.id = tp.task_id
     WHERE tp.task_id = ? AND tp.status = 'open'`
  ).all(taskId) as Array<{
    pr_number: number;
    repo_name: string;
    repo_path: string;
    branch_name: string;
  }>;

  for (const pr of prs) {
    startReviewPoller(taskId, pr.repo_name, pr.repo_path, pr.branch_name, pr.pr_number);
  }
}

export function restartPollersForReviewTasks(): void {
  if (!isGiteaConfigured()) return;

  const db = getDb();

  // Use task_prs for multi-repo support
  const prs = db.query(
    `SELECT tp.task_id, tp.pr_number, r.name as repo_name, r.path as repo_path, t.branch_name
     FROM task_prs tp
     JOIN repos r ON r.id = tp.repo_id
     JOIN tasks t ON t.id = tp.task_id
     WHERE t.status = 'review' AND tp.status = 'open'`
  ).all() as Array<{
    task_id: string;
    pr_number: number;
    repo_name: string;
    repo_path: string;
    branch_name: string;
  }>;

  for (const pr of prs) {
    startReviewPoller(pr.task_id, pr.repo_name, pr.repo_path, pr.branch_name, pr.pr_number);
  }

  if (prs.length > 0) {
    logger.info("Restarted review pollers for in-flight PRs", { count: prs.length });
  }
}
