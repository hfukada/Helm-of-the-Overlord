import { Hono } from "hono";
import { ulid } from "ulid";
import { getDb } from "../../knowledge/db";
import { runTask, cleanupTask } from "../../orchestrator/task-runner";
import { getDiff, getDiffSummary } from "../../workspace/git";
import { worktreeDir } from "../../workspace/manager";
import { logger } from "../../shared/logger";
import { getMessagingManager } from "../../messaging/manager";

const tasks = new Hono();

tasks.post("/", async (c) => {
  const body = await c.req.json<{
    description: string;
    title?: string;
    repo_name?: string;
    repo_names?: string[];
    source?: string;
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
    `INSERT INTO tasks (id, title, description, repo_id, source)
     VALUES (?, ?, ?, ?, ?)`,
    [id, title, body.description, repoIds[0], body.source ?? "cli"]
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
  ).all();
  return c.json(rows);
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
  ).all(id);

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

  return c.json({
    ...task,
    blueprint_state: blueprintState,
    diff,
    diff_summary: diffSummary,
    agent_runs: agentRuns,
    repos: taskRepos,
    prs: taskPrs,
  });
});

tasks.get("/:id/ci-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .query("SELECT ci_output, ci_passed, status FROM tasks WHERE id = ?")
    .get(id) as { ci_output: string | null; ci_passed: number | null; status: string } | null;

  if (!row) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    ci_output: row.ci_output,
    ci_passed: row.ci_passed,
    status: row.status,
  });
});

tasks.get("/:id/lint-output", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .query("SELECT lint_output, lint_passed, status FROM tasks WHERE id = ?")
    .get(id) as { lint_output: string | null; lint_passed: number | null; status: string } | null;

  if (!row) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    lint_output: row.lint_output,
    lint_passed: row.lint_passed,
    status: row.status,
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

tasks.delete("/done", async (c) => {
  const db = getDb();

  const FINISHED_STATUSES = ["committed", "cancelled", "failed"];
  const doneTasks = db.query(
    `SELECT id FROM tasks WHERE status IN (${FINISHED_STATUSES.map(() => "?").join(",")})`
  ).all(...FINISHED_STATUSES) as Array<{ id: string }>;

  const deleted: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const task of doneTasks) {
    try {
      // Archive (and kick members from) the messaging channel
      await getMessagingManager()?.kickAndArchiveTaskChannel(task.id);

      const agentRunIds = db
        .query("SELECT id FROM agent_runs WHERE task_id = ?")
        .all(task.id) as Array<{ id: string }>;

      for (const run of agentRunIds) {
        db.run("DELETE FROM agent_stream WHERE agent_run_id = ?", [run.id]);
      }
      db.run("DELETE FROM agent_runs WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM diff_comments WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM task_input_requests WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM task_messages WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM task_repos WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM task_prs WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM messaging_channels WHERE task_id = ?", [task.id]);
      db.run("DELETE FROM tasks WHERE id = ?", [task.id]);

      deleted.push(task.id);
      logger.info("Finished task deleted via clean-done", { taskId: task.id });
    } catch (err) {
      logger.error("Failed to delete finished task", { taskId: task.id, error: String(err) });
      errors.push({ id: task.id, error: String(err) });
    }
  }

  return c.json({ deleted, errors });
});

tasks.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const task = db.query("SELECT id, status FROM tasks WHERE id = ?").get(id) as { id: string; status: string } | null;
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const terminalStatuses = ["committed", "cancelled", "failed"];
  if (!terminalStatuses.includes(task.status)) {
    // Stop any active work and clean up the worktree before deleting
    await cleanupTask(id).catch((err) => {
      logger.warn("Cleanup failed before delete", { taskId: id, error: String(err) });
    });
  }

  // Archive the messaging channel before deleting DB rows
  await getMessagingManager()?.archiveTaskChannel(id);

  // Delete related rows in dependency order to satisfy foreign-key constraints
  const agentRunIds = db
    .query("SELECT id FROM agent_runs WHERE task_id = ?")
    .all(id) as Array<{ id: string }>;

  for (const run of agentRunIds) {
    db.run("DELETE FROM agent_stream WHERE agent_run_id = ?", [run.id]);
  }
  db.run("DELETE FROM agent_runs WHERE task_id = ?", [id]);
  db.run("DELETE FROM diff_comments WHERE task_id = ?", [id]);
  db.run("DELETE FROM task_input_requests WHERE task_id = ?", [id]);
  db.run("DELETE FROM task_messages WHERE task_id = ?", [id]);
  db.run("DELETE FROM messaging_channels WHERE task_id = ?", [id]);
  db.run("DELETE FROM tasks WHERE id = ?", [id]);

  logger.info("Task deleted", { taskId: id });

  return c.json({ id, deleted: true });
});

// Input requests for human-in-the-loop
tasks.get("/:id/input-requests", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const requests = db.query(
    "SELECT id, question, answer, status, created_at, answered_at FROM task_input_requests WHERE task_id = ? ORDER BY created_at DESC"
  ).all(id);
  return c.json(requests);
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
  ).all(id);
  return c.json(messages);
});

export { tasks };
