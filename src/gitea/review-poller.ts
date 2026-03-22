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
  timer: ReturnType<typeof setInterval> | null;
}

const activePollers = new Map<string, PollerState>();

function loadCursors(taskId: string): { lastReviewId: number; lastCommentId: number } {
  const db = getDb();
  const row = db.query(
    "SELECT gitea_last_review_id, gitea_last_comment_id FROM tasks WHERE id = ?"
  ).get(taskId) as { gitea_last_review_id: number; gitea_last_comment_id: number } | null;
  return {
    lastReviewId: row?.gitea_last_review_id ?? 0,
    lastCommentId: row?.gitea_last_comment_id ?? 0,
  };
}

function saveCursors(taskId: string, lastReviewId: number, lastCommentId: number): void {
  const db = getDb();
  db.run(
    "UPDATE tasks SET gitea_last_review_id = ?, gitea_last_comment_id = ? WHERE id = ?",
    [lastReviewId, lastCommentId, taskId]
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
  saveCursors(taskId, lastReviewId, lastCommentId);
}

export function startReviewPoller(
  taskId: string,
  repoName: string,
  repoPath: string,
  branchName: string,
  prNumber: number
): void {
  // Stop existing poller if any
  stopReviewPoller(taskId);

  const state: PollerState = {
    taskId,
    repoName,
    repoPath,
    branchName,
    prNumber,
    timer: null,
  };

  state.timer = setInterval(() => {
    pollPR(state).catch((err) => {
      logger.warn("PR poll failed", { taskId, prNumber, error: String(err) });
    });
  }, config.giteaPollIntervalMs);

  activePollers.set(taskId, state);

  const { lastReviewId, lastCommentId } = loadCursors(taskId);
  logger.info("Started review poller", { taskId, prNumber, lastReviewId, lastCommentId });
}

export function stopReviewPoller(taskId: string): void {
  const state = activePollers.get(taskId);
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  activePollers.delete(taskId);
}

async function pollPR(state: PollerState): Promise<void> {
  const { taskId, repoName, prNumber } = state;
  let { lastReviewId, lastCommentId } = loadCursors(taskId);

  const pr = await getPullRequest(repoName, prNumber);

  // Check if PR was merged
  if (pr.merged) {
    logger.info("PR merged, marking task committed", { taskId, prNumber });
    stopReviewPoller(taskId);

    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      "UPDATE tasks SET status = 'committed', updated_at = ? WHERE id = ?",
      [now, taskId]
    );
    return;
  }

  // Check if PR was closed without merge
  if (pr.state === "closed") {
    logger.info("PR closed without merge, marking task cancelled", { taskId, prNumber });
    stopReviewPoller(taskId);

    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
      [now, taskId]
    );
    return;
  }

  // Check for new reviews
  const reviews = await listPullRequestReviews(repoName, prNumber);
  const newReviews = reviews.filter((r) => r.id > lastReviewId);

  if (newReviews.length > 0) {
    lastReviewId = Math.max(...newReviews.map((r) => r.id));
    logger.info("New reviews detected", {
      taskId,
      count: newReviews.length,
      states: newReviews.map((r) => r.state),
    });
  }

  // Gitea uses "REQUEST_CHANGES" but normalize to lowercase for safety
  const changeRequests = newReviews.filter(
    (r) => r.state.toLowerCase() === "request_changes" || r.state.toLowerCase() === "rejected"
  );

  if (changeRequests.length > 0) {
    // Collect feedback: review body + inline line comments + general PR comments
    const feedbackParts: string[] = [];

    for (const review of changeRequests) {
      if (review.body?.trim()) {
        feedbackParts.push(review.body);
      }

      // Fetch per-line inline comments for this review
      const inlineComments = await listReviewComments(repoName, prNumber, review.id);
      for (const c of inlineComments) {
        if (c.body?.trim()) {
          feedbackParts.push(`[${c.path}:${c.line}] ${c.body}`);
        }
      }
    }

    // Also include general PR comments (not inline)
    const comments = await listPullRequestComments(repoName, prNumber);
    const botUser = config.giteaBotUser;
    const newComments = comments.filter(
      (c) => c.id > lastCommentId && c.user.login !== botUser
    );
    if (newComments.length > 0) {
      lastCommentId = Math.max(...newComments.map((c) => c.id));
    }
    for (const c of newComments) {
      if (c.body?.trim()) {
        feedbackParts.push(c.body);
      }
    }

    // Persist cursors before starting revision (so restart won't re-trigger)
    saveCursors(taskId, lastReviewId, lastCommentId);

    const feedback = feedbackParts.join("\n\n").trim()
      || "Changes requested (no specific feedback provided).";

    logger.info("Review changes requested, starting revision", { taskId, prNumber, feedback });
    stopReviewPoller(taskId);

    try {
      // reviseTask handles commit, push, and status update internally
      await reviseTask(taskId, feedback);

      await commentOnPullRequest(repoName, prNumber, "Revision complete based on review feedback. Please re-review.");

      // Seed cursors from current Gitea state before restarting poller
      await seedCursors(taskId, repoName, prNumber);

      // Restart poller
      startReviewPoller(taskId, repoName, state.repoPath, state.branchName, prNumber);
    } catch (err) {
      logger.error("Revision after review failed", { taskId, error: String(err) });
      await commentOnPullRequest(repoName, prNumber, `Revision failed: ${err}`).catch(() => {});
      startReviewPoller(taskId, repoName, state.repoPath, state.branchName, prNumber);
    }
    return;
  }

  // Persist updated cursors (even if no rejection, track comment IDs)
  const comments = await listPullRequestComments(repoName, prNumber);
  const botUser = config.giteaBotUser;
  const newComments = comments.filter(
    (c) => c.id > lastCommentId && c.user.login !== botUser
  );
  if (newComments.length > 0) {
    lastCommentId = Math.max(...newComments.map((c) => c.id));
  }

  if (lastReviewId > 0 || lastCommentId > 0) {
    saveCursors(taskId, lastReviewId, lastCommentId);
  }
}

export function restartPollersForReviewTasks(): void {
  if (!isGiteaConfigured()) return;

  const db = getDb();
  const tasks = db.query(
    `SELECT t.id, t.branch_name, t.gitea_pr_number, r.name as repo_name, r.path as repo_path
     FROM tasks t
     JOIN repos r ON r.id = t.repo_id
     WHERE t.status = 'review' AND t.gitea_pr_number IS NOT NULL`
  ).all() as Array<{
    id: string;
    branch_name: string;
    gitea_pr_number: number;
    repo_name: string;
    repo_path: string;
  }>;

  for (const task of tasks) {
    startReviewPoller(task.id, task.repo_name, task.repo_path, task.branch_name, task.gitea_pr_number);
  }

  if (tasks.length > 0) {
    logger.info("Restarted review pollers for in-flight tasks", { count: tasks.length });
  }
}
