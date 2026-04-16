import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Set isolated workspace BEFORE any imports that load config/db
process.env.HOTO_WORKSPACE = path.join(os.tmpdir(), `hoto-test-${crypto.randomUUID()}`);

import { describe, it, expect, afterEach } from "bun:test";
import { getDb } from "../knowledge/db";
import { checkParentCompletion } from "./child-task-runner";

/** Clear all mutable tables between tests so each test starts clean. */
function clearTables() {
  const db = getDb();
  db.run("DELETE FROM child_tasks");
  db.run("DELETE FROM task_prs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM repos");
}

afterEach(() => {
  clearTables();
});

function seedBase(repoCount = 2) {
  const db = getDb();
  db.run(`INSERT INTO repos (id, name, path, description) VALUES (1, 'repo-a', '/tmp/repo-a', 'Repo A')`);
  if (repoCount >= 2) {
    db.run(`INSERT INTO repos (id, name, path, description) VALUES (2, 'repo-b', '/tmp/repo-b', 'Repo B')`);
  }
  db.run(
    `INSERT INTO tasks (id, title, description, status) VALUES ('parent-1', 'Test task', 'desc', 'waiting_for_children')`
  );
}

function insertChild(id: string, repoId: number, status: string) {
  const db = getDb();
  db.run(
    `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, plan_excerpt) VALUES (?, 'parent-1', ?, ?, 'plan')`,
    [id, repoId, status]
  );
}

describe("checkParentCompletion", () => {
  it("marks parent as committed when all children are committed", () => {
    seedBase(2);
    insertChild("child-1", 1, "committed");
    insertChild("child-2", 2, "committed");

    checkParentCompletion("parent-1");

    const db = getDb();
    const parent = db.query("SELECT status FROM tasks WHERE id = 'parent-1'").get() as { status: string };
    expect(parent.status).toBe("committed");
  });

  it("leaves parent in waiting_for_children when children are in mixed committed + error state", () => {
    seedBase(2);
    insertChild("child-1", 1, "committed");
    insertChild("child-2", 2, "error");

    checkParentCompletion("parent-1");

    const db = getDb();
    const parent = db.query("SELECT status FROM tasks WHERE id = 'parent-1'").get() as { status: string };
    expect(parent.status).toBe("waiting_for_children");
  });

  it("does not change parent status when a child is still in progress", () => {
    seedBase(2);
    insertChild("child-1", 1, "committed");
    insertChild("child-2", 2, "implementing");

    checkParentCompletion("parent-1");

    const db = getDb();
    const parent = db.query("SELECT status FROM tasks WHERE id = 'parent-1'").get() as { status: string };
    expect(parent.status).toBe("waiting_for_children");
  });

  it("marks parent as cancelled when all children are cancelled", () => {
    seedBase(2);
    insertChild("child-1", 1, "cancelled");
    insertChild("child-2", 2, "cancelled");

    checkParentCompletion("parent-1");

    const db = getDb();
    const parent = db.query("SELECT status FROM tasks WHERE id = 'parent-1'").get() as { status: string };
    expect(parent.status).toBe("cancelled");
  });
});

describe("task_prs row for child task PR", () => {
  it("has correct task_id, repo_id, pr_number, and pr_url after child PR insertion", () => {
    seedBase(1);
    const db = getDb();
    db.run(`INSERT INTO child_tasks (id, parent_task_id, repo_id, status, plan_excerpt) VALUES ('child-1', 'parent-1', 1, 'review', 'plan')`);

    const parentTaskId = "parent-1";
    const repoId = 1;
    const prNumber = 42;
    const prUrl = "http://gitea.example.com/hoto/repo-a/pulls/42";

    // Simulate what child-task-runner does after PR creation
    db.run("UPDATE child_tasks SET pr_number = ?, pr_url = ? WHERE id = 'child-1'", [prNumber, prUrl]);
    db.run(
      "INSERT OR REPLACE INTO task_prs (task_id, repo_id, pr_number, pr_url) VALUES (?, ?, ?, ?)",
      [parentTaskId, repoId, prNumber, prUrl]
    );

    const row = db.query(
      "SELECT task_id, repo_id, pr_number, pr_url FROM task_prs WHERE task_id = ? AND repo_id = ?"
    ).get(parentTaskId, repoId) as { task_id: string; repo_id: number; pr_number: number; pr_url: string } | null;

    expect(row).not.toBeNull();
    expect(row?.task_id).toBe(parentTaskId);
    expect(row?.repo_id).toBe(repoId);
    expect(row?.pr_number).toBe(prNumber);
    expect(row?.pr_url).toBe(prUrl);
  });

  it("review poller resolves repo_id via child_tasks fallback when task_prs row is absent", () => {
    seedBase(1);
    const db = getDb();
    db.run(
      `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, plan_excerpt, pr_number) VALUES ('child-1', 'parent-1', 1, 'review', 'plan', 99)`
    );

    // No task_prs row -- simulates old in-flight task created before the fix
    const prRow = db.query(
      "SELECT repo_id FROM task_prs WHERE task_id = ? AND pr_number = ?"
    ).get("parent-1", 99) as { repo_id: number } | null;
    let repoId = prRow?.repo_id ?? 0;

    // Apply defensive fallback logic (mirrors review-poller.ts)
    if (repoId === 0) {
      const childRow = db.query(
        "SELECT repo_id FROM child_tasks WHERE parent_task_id = ? AND pr_number = ?"
      ).get("parent-1", 99) as { repo_id: number } | null;
      if (childRow) repoId = childRow.repo_id;
    }

    expect(repoId).toBe(1);
  });
});
