import { Hono } from "hono";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { runTask, cleanupTask } from "../../orchestrator/task-runner";
import { getDiff, getDiffSummary } from "../../workspace/git";
import { worktreeDir } from "../../workspace/manager";
import { logger } from "../../shared/logger";
import { getMessagingManager } from "../../messaging/manager";
import { fixDates, fixDatesAll } from "../dates";

const tasks = new Hono();

tasks.post("/", async (c) => {
  const body = await c.req.json<{
    description: string;
    title?: string;
    repo_name?: string;
    repo_names?: string[];
    source?: string;
    source_sender_id?: string;
    source_provider?: string;
  }>();

  const db = getDb();

  // Resolve repo IDs -- support both single and multi-repo
  const repoIds: number[] = [];

  if (body.repo_names && body.repo_names.length > 0) {
    for (const name of body.repo_names) {
      const repo = db.query("SELECT id FROM repos WHERE name = ? AND archived = 0").get(name) as { id: number } | null;
      if (!repo) {
        return c.json({ error: `Repo '${name}' not found` }, 404);
      }
      repoIds.push(repo.id);
    }
  } else if (body.repo_name) {
    const repo = db.query("SELECT id FROM repos WHERE name = ? AND archived = 0").get(body.repo_name) as { id: number } | null;
    if (!repo) {
      return c.json({ error: `Repo '${body.repo_name}' not found` }, 404);
    }
    repoIds.push(repo.id);
  } else {
    // No repo specified -- assign all active repos, let pre-plan narrow it down
    const repos = db.query("SELECT id FROM repos WHERE archived = 0").all() as Array<{ id: number }>;
    if (repos.length === 0) {
      return c.json({ error: "No repos registered. Use 'hoto repos add' first." }, 400);
    }
    for (const r of repos) {
      repoIds.push(r.id);
    }
  }

  const id = ulid();
  const title = body.title ?? body.description.slice(0, 80);

  // Insert task with first repo as primary (legacy compat)
  db.run(
    `INSERT INTO tasks (id, title, description, repo_id, source, source_sender_id, source_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, title, body.description, repoIds[0], body.source ?? "cli", body.source_sender_id ?? null, body.source_provider ?? null]
  );

  // Insert task_repos junction rows
  for (const repoId of repoIds) {
    db.run(
      "INSERT INTO task_repos (task_id, repo_id, role) VALUES (?, ?, 'target')",
      [id, repoId]
    );
  }

  logger.info("Task created", { taskId: id, title, repoCount: repoIds.length });

  // Fire and forget -- run task in background
  runTask(id).catch((err) => {
    logger.error("Task execution failed", { taskId: id, error: String(err) });
    const db = getDb();
    db.run("UPDATE tasks SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [id]);
  });

  return c.json({ id, title, status: "pending", repo_count: repoIds.length }, 201);
});

tasks.get("/", (c) => {
  const db = getDb();
  const rows = db.query(
    "SELECT id, title, status, repo_id, branch_name, source, created_at, updated_at FROM tasks ORDER BY created_at DESC"
  ).all() as Array<Record<string, unknown>>;
  return c.json(fixDatesAll(rows, "created_at", "updated_at"));
});

tasks.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // If in review status, include diff
  let diff: string | null = null;
  let diffSummary: Array<{ file: string; insertions: number; deletions: number }> | null = null;

  if ((task.status === "review" || task.status === "accepted") && task.repo_id) {
    const repo = db.query("SELECT name FROM repos WHERE id = ?").get(task.repo_id as number) as { name: string } | null;
    if (repo) {
      try {
        const wtDir = worktreeDir(id, repo.name);
        diff = await getDiff(wtDir);
        diffSummary = await getDiffSummary(wtDir);
      } catch (err) {
        logger.warn("Failed to get diff", { taskId: id, error: String(err) });
      }
    }
  }

  // Include agent runs
  const agentRuns = db.query(
    "SELECT id, node_name, agent_type, status, prompt, output, token_input, token_output, cost_usd, model, started_at, finished_at, error FROM agent_runs WHERE task_id = ? ORDER BY started_at"
  ).all(id) as Array<Record<string, unknown>>;
  fixDatesAll(agentRuns, "started_at", "finished_at");

  // Parse blueprint_state
  let blueprintState = null;
  if (task.blueprint_state) {
    try {
      blueprintState = JSON.parse(task.blueprint_state as string);
    } catch {}
  }

  // Include repos from task_repos
  const taskRepos = db.query(
    `SELECT r.id, r.name, r.language, r.framework, tr.role
     FROM task_repos tr JOIN repos r ON r.id = tr.repo_id
     WHERE tr.task_id = ? ORDER BY r.name`
  ).all(id);

  // Include PRs from task_prs
  const taskPrs = db.query(
    `SELECT tp.id, tp.repo_id, tp.pr_number, tp.pr_url, tp.status, r.name as repo_name
     FROM task_prs tp JOIN repos r ON r.id = tp.repo_id
     WHERE tp.task_id = ? ORDER BY r.name`
  ).all(id);

  fixDates(task, "created_at", "updated_at");

  // Include child tasks with their own agent runs and CI/lint output
  const childRows = db.query(
    `SELECT ct.id, ct.status, ct.pr_number, ct.pr_url, ct.ci_passed, ct.lint_passed,
            ct.ci_output, ct.lint_output, ct.created_at, ct.updated_at,
            r.name as repo_name, r.language
     FROM child_tasks ct
     JOIN repos r ON r.id = ct.repo_id
     WHERE ct.parent_task_id = ?
     ORDER BY r.name`
  ).all(id) as Array<Record<string, unknown>>;
  fixDatesAll(childRows, "created_at", "updated_at");

  const children = childRows.map((child) => {
    const childRuns = db.query(
      `SELECT id, node_name, agent_type, status, prompt, output, token_input, token_output,
              cost_usd, model, started_at, finished_at, error
       FROM agent_runs WHERE task_id = ? AND child_task_id = ? ORDER BY started_at`
    ).all(id, child.id as string) as Array<Record<string, unknown>>;
    fixDatesAll(childRuns, "started_at", "finished_at");

    const childCiRuns = db.query(
      `SELECT id, output, passed, created_at
       FROM task_ci_lint_runs
       WHERE child_task_id = ? AND run_type = 'ci'
       ORDER BY created_at ASC`
    ).all(child.id as string) as Array<Record<string, unknown>>;

    const childLintRuns = db.query(
      `SELECT id, output, passed, created_at
       FROM task_ci_lint_runs
       WHERE child_task_id = ? AND run_type = 'lint'
       ORDER BY created_at ASC`
    ).all(child.id as string) as Array<Record<string, unknown>>;

    return {
      ...child,
      runs: childRuns,
      ci_runs: childCiRuns,
      lint_runs: childLintRuns,
    };
  });

  // Parent-level agent runs (no child_task_id)
  const parentRuns = db.query(
    `SELECT id, node_name, agent_type, status, prompt, output, token_input, token_output,
            cost_usd, model, started_at, finished_at, error
     FROM agent_runs WHERE task_id = ? AND child_task_id IS NULL ORDER BY started_at`
  ).all(id) as Array<Record<string, unknown>>;
  fixDatesAll(parentRuns, "started_at", "finished_at");

  const ciRuns = db.query(
    `SELECT id, child_task_id, output, passed, created_at
     FROM task_ci_lint_runs
     WHERE task_id = ? AND run_type = 'ci'
     ORDER BY created_at ASC`
  ).all(id) as Array<Record<string, unknown>>;

  const lintRuns = db.query(
    `SELECT id, child_task_id, output, passed, created_at
     FROM task_ci_lint_runs
     WHERE task_id = ? AND run_type = 'lint'
     ORDER BY created_at ASC`
  ).all(id) as Array<Record<string, unknown>>;

  return c.json({
    ...task,
    blueprint_state: blueprintState,
    diff,
    diff_summary: diffSummary,
    agent_runs: parentRuns,
    repos: taskRepos,
    prs: taskPrs,
    children,
    ci_runs: ciRuns,
    lint_runs: lintRuns,
  });
});

tasks.get("/:id/ci-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const taskStatus = db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | null;

  if (!taskStatus) {
    return c.json({ error: "Task not found" }, 404);
  }

  const run = db.query(
    `SELECT output, passed FROM task_ci_lint_runs
     WHERE task_id = ? AND run_type = 'ci'
     ORDER BY created_at DESC LIMIT 1`
  ).get(id) as { output: string | null; passed: number | null } | null;

  return c.json({
    output: run?.output ?? null,
    passed: run?.passed ?? null,
    status: taskStatus.status,
  });
});

tasks.get("/:id/lint-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const taskStatus = db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | null;

  if (!taskStatus) {
    return c.json({ error: "Task not found" }, 404);
  }

  const run = db.query(
    `SELECT output, passed FROM task_ci_lint_runs
     WHERE task_id = ? AND run_type = 'lint'
     ORDER BY created_at DESC LIMIT 1`
  ).get(id) as { output: string | null; passed: number | null } | null;

  return c.json({
    output: run?.output ?? null,
    passed: run?.passed ?? null,
    status: taskStatus.status,
  });
});

tasks.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('committed', 'cancelled')",
    [now, id]
  );
  if (result.changes === 0) {
    return c.json({ error: "Task not found or already in terminal state" }, 400);
  }

  logger.info("Task cancelled, running cleanup", { taskId: id });

  // Run cleanup asynchronously so the response returns immediately
  cleanupTask(id).catch((err) => {
    logger.error("Cleanup failed after cancel", { taskId: id, error: String(err) });
  });

  return c.json({ id, status: "cancelled" });
});

/**
 * Delete a task and all related data. Kicks members from the channel,
 * archives it, cleans up worktree if still running, and removes all DB rows.
 */
async function deleteTask(taskId: string): Promise<void> {
  const db = getDb();

  const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
  if (!task) throw new Error("Task not found");

  const terminalStatuses = ["committed", "cancelled", "failed"];
  if (!terminalStatuses.includes(task.status)) {
    await cleanupTask(taskId).catch((err) => {
      logger.warn("Cleanup failed before delete", { taskId, error: String(err) });
    });
  }

  // Kick members and archive the messaging channel
  const manager = getMessagingManager();
  if (manager) {
    await manager.kickAndArchiveTaskChannel(taskId).catch((err: unknown) => {
      logger.warn("Failed to kick/archive channel", { taskId, error: String(err) });
    });
  }

  // Delete related rows in dependency order
  const agentRunIds = db
    .query("SELECT id FROM agent_runs WHERE task_id = ?")
    .all(taskId) as Array<{ id: string }>;

  for (const run of agentRunIds) {
    db.run("DELETE FROM agent_stream WHERE agent_run_id = ?", [run.id]);
  }
  db.run("DELETE FROM agent_runs WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM diff_comments WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM task_input_requests WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM task_messages WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM task_repos WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM task_prs WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM messaging_channels WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM task_ci_lint_runs WHERE task_id = ?", [taskId]);
  db.run("DELETE FROM tasks WHERE id = ?", [taskId]);

  logger.info("Task deleted", { taskId });
}

tasks.delete("/done", async (c) => {
  const db = getDb();

  const ALL_VALID_STATUSES = ["committed", "cancelled", "failed", "error", "implementing", "planning", "scrutinizing", "linting", "ci", "review", "accepted"];
  const FINISHED_STATUSES = ["committed", "cancelled", "failed", "error"];

  const statusParam = c.req.query("status");
  let statusesToQuery: string[];

  if (statusParam !== undefined) {
    if (!ALL_VALID_STATUSES.includes(statusParam)) {
      return c.json(
        { error: `Unknown status: ${statusParam}. Valid statuses: ${ALL_VALID_STATUSES.join(", ")}` },
        400
      );
    }
    statusesToQuery = [statusParam];
  } else {
    statusesToQuery = FINISHED_STATUSES;
  }

  const doneTasks = db.query(
    `SELECT id FROM tasks WHERE status IN (${statusesToQuery.map(() => "?").join(",")})`
  ).all(...statusesToQuery) as Array<{ id: string }>;

  const deleted: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const task of doneTasks) {
    try {
      await deleteTask(task.id);
      deleted.push(task.id);
    } catch (err) {
      logger.error("Failed to delete task", { taskId: task.id, error: String(err) });
      errors.push({ id: task.id, error: String(err) });
    }
  }

  return c.json({ deleted, errors });
});

tasks.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const task = db.query("SELECT id FROM tasks WHERE id = ?").get(id) as { id: string } | null;
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  try {
    await deleteTask(id);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }

  return c.json({ id, deleted: true });
});

// Input requests for human-in-the-loop
tasks.get("/:id/input-requests", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const requests = db.query(
    "SELECT id, question, answer, status, created_at, answered_at FROM task_input_requests WHERE task_id = ? ORDER BY created_at DESC"
  ).all(id) as Array<Record<string, unknown>>;
  return c.json(fixDatesAll(requests, "created_at", "answered_at"));
});

tasks.post("/:id/input-requests/:requestId/answer", async (c) => {
  const requestId = c.req.param("requestId");
  const body = await c.req.json<{ answer: string }>();

  if (!body.answer?.trim()) {
    return c.json({ error: "answer is required" }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE task_input_requests SET answer = ?, status = 'answered', answered_at = ? WHERE id = ? AND status = 'pending'",
    [body.answer, now, requestId]
  );

  if (result.changes === 0) {
    return c.json({ error: "Request not found or already answered" }, 400);
  }

  return c.json({ id: requestId, status: "answered" });
});

// Task messages (chat history)
tasks.get("/:id/messages", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const messages = db.query(
    "SELECT id, source, sender_id, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at"
  ).all(id) as Array<Record<string, unknown>>;
  return c.json(fixDatesAll(messages, "created_at"));
});

export { tasks };
