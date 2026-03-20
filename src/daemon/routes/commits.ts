import { Hono } from "hono";
import { advanceState } from "../../orchestrator/blueprint";
import { getDb } from "../../knowledge/db";
import { commitAndPush } from "../../workspace/git";
import { worktreeDir } from "../../workspace/manager";
import { logger } from "../../shared/logger";
import { reviseTask } from "../../orchestrator/task-runner";

const commits = new Hono();

// Accept a task (mark as accepted, ready for commit)
commits.post("/:id/accept", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.run(
    "UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'review'",
    [now, id]
  );
  if (result.changes === 0) {
    return c.json(
      { error: "Task not found or not in review status" },
      400
    );
  }
  return c.json({ id, status: "accepted" });
});

// Commit and push
commits.post("/:id/commit", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    message: string;
    branch_name?: string;
  }>();

  if (!body.message) {
    return c.json({ error: "Commit message is required" }, 400);
  }

  const db = getDb();
  const task = db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | null;

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  if (task.status !== "review" && task.status !== "accepted") {
    return c.json(
      { error: "Task must be in review or accepted status to commit" },
      400
    );
  }

  const repo = db
    .query("SELECT name FROM repos WHERE id = ?")
    .get(task.repo_id as number) as { name: string } | null;

  if (!repo) {
    return c.json({ error: "Associated repo not found" }, 500);
  }

  const branchName =
    body.branch_name ?? (task.branch_name as string);

  if (!branchName) {
    return c.json({ error: "No branch name available" }, 400);
  }

  try {
    const wtDir = worktreeDir(id, repo.name);
    await commitAndPush(wtDir, body.message, branchName);

    const now = new Date().toISOString();

    // Advance blueprint state from review -> commit, then close the commit node
    let updatedBlueprintState: string | null = null;
    if (task.blueprint_state) {
      try {
        let bpState = JSON.parse(task.blueprint_state as string);
        bpState = advanceState(bpState, "accept");
        // Close the commit node immediately since this is a synchronous operation
        bpState = {
          ...bpState,
          history: bpState.history.map((h: { node: string; exited_at: string | null; result: string | null }) =>
            h.node === "commit" && !h.exited_at
              ? { ...h, exited_at: now, result: "done" }
              : h
          ),
        };
        updatedBlueprintState = JSON.stringify(bpState);
      } catch {
        // blueprint state update is best-effort
      }
    }

    if (updatedBlueprintState) {
      db.run(
        "UPDATE tasks SET status = 'committed', blueprint_state = ?, updated_at = ? WHERE id = ?",
        [updatedBlueprintState, now, id]
      );
    } else {
      db.run(
        "UPDATE tasks SET status = 'committed', updated_at = ? WHERE id = ?",
        [now, id]
      );
    }

    logger.info("Task committed and pushed", {
      taskId: id,
      branch: branchName,
    });

    return c.json({ id, status: "committed", branch: branchName });
  } catch (err) {
    logger.error("Commit failed", { taskId: id, error: String(err) });
    return c.json({ error: `Commit failed: ${String(err)}` }, 500);
  }
});

// Reject and request revision
commits.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ comment?: string }>();

  const db = getDb();
  const task = db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | null;

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  if (task.status !== "review" && task.status !== "accepted") {
    return c.json(
      { error: "Task must be in review or accepted status to reject" },
      400
    );
  }

  const feedback = body.comment?.trim() || "Please revise the implementation.";

  logger.info("Task rejected, starting revision", { taskId: id });

  // Fire and forget -- the revision runs in the background
  reviseTask(id, feedback).catch((err) => {
    logger.error("Revision failed", { taskId: id, error: String(err) });
    const now = new Date().toISOString();
    db.run("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?", [now, id]);
  });

  return c.json({ id, status: "implementing" });
});

export { commits };
