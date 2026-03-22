import {
  getPullRequest,
  listPullRequestReviews,
  listPullRequestComments,
  commentOnPullRequest,
  isGiteaConfigured,
} from "./client";
import { pushBranchToGitea } from "./repo-sync";
import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import { reviseTask } from "../orchestrator/task-runner";
import { worktreeDir } from "../workspace/manager";

interface PollerState {
  taskId: string;
  repoName: string;
  repoPath: string;
  branchName: string;
  prNumber: number;
  lastReviewId: number;
  lastCommentId: number;
  timer: ReturnType<typeof setInterval> | null;
}

const activePollers = new Map<string, PollerState>();

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
    lastReviewId: 0,
    lastCommentId: 0,
    timer: null,
  };

  state.timer = setInterval(() => {
    pollPR(state).catch((err) => {
      logger.warn("PR poll failed", { taskId, prNumber, error: String(err) });
    });
  }, config.giteaPollIntervalMs);

  activePollers.set(taskId, state);
  logger.info("Started review poller", { taskId, prNumber });
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

  // Check for new reviews requesting changes
  const reviews = await listPullRequestReviews(repoName, prNumber);
  const newReviews = reviews.filter((r) => r.id > state.lastReviewId);

  if (newReviews.length > 0) {
    state.lastReviewId = Math.max(...newReviews.map((r) => r.id));
  }

  const changeRequests = newReviews.filter(
    (r) => r.state === "REQUEST_CHANGES" || r.state === "request_changes"
  );

  if (changeRequests.length > 0) {
    const feedback = changeRequests
      .map((r) => r.body)
      .filter(Boolean)
      .join("\n\n");

    if (feedback.trim()) {
      logger.info("Review changes requested, starting revision", { taskId, prNumber });
      stopReviewPoller(taskId);

      // Run revision then re-push and restart poller
      try {
        await reviseTask(taskId, feedback);

        // After revision, push updated branch
        const workDir = worktreeDir(taskId, repoName);
        await pushBranchToGitea(workDir, state.repoPath, repoName, state.branchName, true);

        await commentOnPullRequest(repoName, prNumber, "Revision complete based on review feedback. Please re-review.");

        // Restart poller
        startReviewPoller(taskId, repoName, state.repoPath, state.branchName, prNumber);
      } catch (err) {
        logger.error("Revision after review failed", { taskId, error: String(err) });
        await commentOnPullRequest(repoName, prNumber, `Revision failed: ${err}`).catch(() => {});
        // Restart poller to keep watching
        startReviewPoller(taskId, repoName, state.repoPath, state.branchName, prNumber);
      }
      return;
    }
  }

  // Check for new general comments (not from the bot) that might indicate feedback
  const comments = await listPullRequestComments(repoName, prNumber);
  const botUser = config.giteaBotUser;
  const newComments = comments.filter(
    (c) => c.id > state.lastCommentId && c.user.login !== botUser
  );

  if (newComments.length > 0) {
    state.lastCommentId = Math.max(...newComments.map((c) => c.id));
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
