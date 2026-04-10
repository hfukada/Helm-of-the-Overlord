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

  const existing = activePollers.get(key);
  if (existing?.timer) {
    clearInterval(existing.timer);
  }

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

export function stopTaskPollers(taskId: string): void {
  for (const [key, state] of activePollers) {
    if (state.taskId === taskId) {
      if (state.timer) clearInterval(state.timer);
      activePollers.delete(key);
    }
  }
}

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

/** Check PR resolution state for a task. */
function getPrResolution(taskId: string): { allResolved: boolean; allMerged: boolean; rejected: Array<{ repo_name: string; repo_id: number; pr_number: number }>; merged: Array<{ repo_name: string }> } {
  const db = getDb();
  const prs = db.query(
    `SELECT tp.status, tp.repo_id, tp.pr_number, r.name as repo_name
     FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
     WHERE tp.task_id = ?`
  ).all(taskId) as Array<{ status: string; repo_id: number; pr_number: number; repo_name: string }>;

  const merged = prs.filter((p) => p.status === "merged");
  const rejected = prs.filter((p) => p.status === "rejected");
  const open = prs.filter((p) => p.status === "open");

  return {
    allResolved: open.length === 0,
    allMerged: rejected.length === 0 && open.length === 0 && merged.length > 0,
    rejected,
    merged,
  };
}

/** Collect feedback from a single rejected PR. */
async function collectRejectedFeedbackForRepo(repoName: string, prNumber: number): Promise<string> {
  const feedbackParts: string[] = [];
  const botUser = config.giteaBotUser;

  const reviews = await listPullRequestReviews(repoName, prNumber);
  const changeRequests = reviews.filter(
    (r) => r.state.toLowerCase() === "request_changes" || r.state.toLowerCase() === "rejected"
  );

  for (const review of changeRequests) {
    if (review.body?.trim()) feedbackParts.push(review.body);
    const inlineComments = await listReviewComments(repoName, prNumber, review.id);
    for (const c of inlineComments) {
      if (c.body?.trim()) feedbackParts.push(`[${c.path}:${c.line}] ${c.body}`);
    }
  }

  const comments = await listPullRequestComments(repoName, prNumber);
  const newComments = comments.filter((c) => c.user.login !== botUser);
  for (const c of newComments) {
    if (c.body?.trim()) feedbackParts.push(c.body);
  }

  return feedbackParts.join("\n\n").trim() || "Changes requested (no specific feedback provided).";
}

/** Collect feedback from rejected PRs only. */
async function collectRejectedFeedback(taskId: string): Promise<string> {
  const db = getDb();
  const prs = db.query(
    `SELECT tp.repo_id, tp.pr_number, tp.last_review_id, tp.last_comment_id, r.name as repo_name
     FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
     WHERE tp.task_id = ? AND tp.status = 'rejected'`
  ).all(taskId) as Array<{
    repo_id: number;
    pr_number: number;
    last_review_id: number;
    last_comment_id: number;
    repo_name: string;
  }>;

  const { merged } = getPrResolution(taskId);

  const feedbackParts: string[] = [];
  const botUser = config.giteaBotUser;

  // Context: which repos were accepted
  if (merged.length > 0) {
    feedbackParts.push(`## Accepted Repos (no changes needed)`);
    feedbackParts.push(merged.map((m) => `- ${m.repo_name}: merged/accepted`).join("\n"));
    feedbackParts.push("");
  }

  // Feedback from rejected PRs
  for (const pr of prs) {
    feedbackParts.push(`## Rejected: ${pr.repo_name} (PR #${pr.pr_number})`);
    feedbackParts.push(`This repo's PR was rejected. Address the feedback below.`);

    const reviews = await listPullRequestReviews(pr.repo_name, pr.pr_number);
    const changeRequests = reviews.filter(
      (r) => r.state.toLowerCase() === "request_changes" || r.state.toLowerCase() === "rejected"
    );

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

    // General comments
    const comments = await listPullRequestComments(pr.repo_name, pr.pr_number);
    const newComments = comments.filter((c) => c.user.login !== botUser);
    for (const c of newComments) {
      if (c.body?.trim()) {
        feedbackParts.push(c.body);
      }
    }
  }

  return feedbackParts.join("\n\n").trim() || "Changes requested (no specific feedback provided).";
}

/** Called when all PRs are resolved. Triggers revision if any were rejected. */
async function handleAllPrsResolved(taskId: string): Promise<void> {
  // Guard: task may have been deleted while pollers were running
  const db = getDb();
  const taskExists = db.query("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
  if (!taskExists) {
    logger.warn("Task deleted, stopping pollers", { taskId });
    stopTaskPollers(taskId);
    return;
  }

  const { allMerged, rejected, merged } = getPrResolution(taskId);

  if (allMerged) {
    logger.info("All PRs merged, marking task committed", { taskId });
    stopTaskPollers(taskId);
    const now = new Date().toISOString();
    db.run("UPDATE tasks SET status = 'committed', updated_at = ? WHERE id = ?", [now, taskId]);
    return;
  }

  if (rejected.length === 0) return; // shouldn't happen but guard

  const rejectedNames = rejected.map((r) => r.repo_name);
  const mergedNames = merged.map((m) => m.repo_name);
  logger.info("All PRs reviewed, some rejected", {
    taskId,
    rejected: rejectedNames,
    merged: mergedNames,
  });

  // Notify chat
  const { getMessagingManager } = await import("../messaging/manager");
  const manager = getMessagingManager();
  if (manager) {
    const lines = [];
    if (mergedNames.length > 0) lines.push(`Accepted: ${mergedNames.join(", ")}`);
    lines.push(`Rejected: ${rejectedNames.join(", ")}`);
    lines.push("Starting revision for rejected repos...");
    manager.notifyAgentOutput(taskId, lines.join("\n")).catch(() => {});
  }

  // Stop all pollers
  stopTaskPollers(taskId);

  // Collect feedback from rejected PRs only
  const feedback = await collectRejectedFeedback(taskId);

  // Reset rejected PRs to open for re-push after revision
  db.run("UPDATE task_prs SET status = 'open' WHERE task_id = ? AND status = 'rejected'", [taskId]);

  try {
    await reviseTask(taskId, feedback);

    // Comment on rejected PRs
    for (const rpr of rejected) {
      await commentOnPullRequest(rpr.repo_name, rpr.pr_number, "Revision complete based on review feedback. Please re-review.").catch(() => {});
    }

    // Seed cursors and restart pollers for open PRs only (not merged ones)
    const openPrs = db.query(
      `SELECT tp.pr_number, r.name as repo_name
       FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
       WHERE tp.task_id = ? AND tp.status = 'open'`
    ).all(taskId) as Array<{ pr_number: number; repo_name: string }>;

    for (const opr of openPrs) {
      await seedCursors(taskId, opr.repo_name, opr.pr_number);
      const info = findPollerInfo(taskId, opr.repo_name);
      if (info) {
        startReviewPoller(taskId, opr.repo_name, info.repoPath, info.branchName, opr.pr_number);
      }
    }
  } catch (err) {
    logger.error("Revision after review failed", { taskId, error: String(err) });
    for (const rpr of rejected) {
      await commentOnPullRequest(rpr.repo_name, rpr.pr_number, `Revision failed: ${err}`).catch(() => {});
    }
    restartPollersForTask(taskId);
  }
}

async function pollPR(state: PollerState): Promise<void> {
  const { taskId, repoName, repoId, prNumber } = state;

  // Guard: task may have been deleted
  const db = getDb();
  if (!db.query("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) {
    logger.warn("Task deleted, stopping poller", { taskId, repoName });
    stopReviewPoller(taskId, repoName);
    return;
  }

  let { lastReviewId, lastCommentId } = loadCursors(taskId, repoId);

  const pr = await getPullRequest(repoName, prNumber);

  // Check if PR was merged
  if (pr.merged) {
    logger.info("PR merged", { taskId, repoName, prNumber });
    stopReviewPoller(taskId, repoName);

    const db = getDb();
    db.run("UPDATE task_prs SET status = 'merged' WHERE task_id = ? AND repo_id = ?", [taskId, repoId]);

    // Update child task if this is a multi-repo task
    const now = new Date().toISOString();
    db.run(
      "UPDATE child_tasks SET status = 'committed', updated_at = ? WHERE parent_task_id = ? AND repo_id = ?",
      [now, taskId, repoId]
    );

    // Notify chat
    const { getMessagingManager } = await import("../messaging/manager");
    const manager = getMessagingManager();
    if (manager) {
      manager.notifyAgentOutput(taskId, `[${repoName}] PR merged (#${prNumber})`).catch(() => {});
    }

    // Check parent completion for child tasks
    const { checkParentCompletion } = await import("../orchestrator/child-task-runner");
    checkParentCompletion(taskId);

    // Check if all PRs are now resolved (legacy multi-repo and single-repo flow)
    const { allResolved } = getPrResolution(taskId);
    if (allResolved) {
      await handleAllPrsResolved(taskId);
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
    logger.info("PR rejected", { taskId, repoName, prNumber });

    const db = getDb();
    saveCursors(taskId, repoId, lastReviewId, lastCommentId);
    stopReviewPoller(taskId, repoName);

    // Check if this is a child task PR
    const childRow = db.query(
      "SELECT id FROM child_tasks WHERE parent_task_id = ? AND repo_id = ?"
    ).get(taskId, repoId) as { id: string } | null;

    if (childRow) {
      // Child task: handle revision independently for this repo
      logger.info("Child task PR rejected, triggering child revision", { taskId, repoName, childId: childRow.id });
      const { getMessagingManager } = await import("../messaging/manager");
      const manager = getMessagingManager();
      if (manager) {
        manager.notifyAgentOutput(taskId, `[${repoName}] PR rejected (#${prNumber}). Starting revision...`).catch(() => {});
      }

      // Collect feedback for this specific PR
      const feedback = await collectRejectedFeedbackForRepo(repoName, prNumber);
      db.run("UPDATE child_tasks SET status = 'implementing', updated_at = datetime('now') WHERE id = ?", [childRow.id]);

      // Trigger child revision (import lazily to avoid circular)
      const { reviseChildTask } = await import("../orchestrator/child-task-runner");
      reviseChildTask(childRow.id, feedback).catch((err) => {
        logger.error("Child task revision failed", { childId: childRow.id, error: String(err) });
        db.run("UPDATE child_tasks SET status = 'error', updated_at = datetime('now') WHERE id = ?", [childRow.id]);
      });
      return;
    }

    // Legacy/single-repo: mark rejected and wait for all PRs
    db.run("UPDATE task_prs SET status = 'rejected' WHERE task_id = ? AND repo_id = ?", [taskId, repoId]);

    // Notify chat
    const { getMessagingManager } = await import("../messaging/manager");
    const manager = getMessagingManager();
    if (manager) {
      manager.notifyAgentOutput(taskId, `PR rejected: ${repoName} (#${prNumber}). Waiting for other PRs to be reviewed...`).catch(() => {});
    }

    // Check if all PRs are now resolved
    const { allResolved } = getPrResolution(taskId);
    if (allResolved) {
      await handleAllPrsResolved(taskId);
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
