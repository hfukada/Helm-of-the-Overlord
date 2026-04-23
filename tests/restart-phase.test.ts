import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import {
  restartFromPhase,
  createInitialState,
  advanceState,
} from "../src/orchestrator/blueprint";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-restart-phase";

mock.module("../src/orchestrator/subprocess-registry", () => ({
  killTaskSubprocesses: async () => {},
}));

mock.module("../src/messaging/manager", () => ({
  getMessagingManager: () => null,
}));

mock.module("../src/shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

mock.module("../src/workspace/git", () => ({
  createTaskClone: async () => { throw new Error("no git in tests"); },
  generateBranchName: () => "test-branch",
}));

mock.module("../src/workspace/manager", () => ({
  ensureTaskDir: async () => {},
  taskDir: () => "/tmp/task",
  worktreeDir: () => "/tmp/worktree",
}));

import { getDb } from "../src/knowledge/db";

describe("restartFromPhase", () => {
  it("resets current_node and zeroes round counts", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // index → plan
    const result = restartFromPhase(state, "index");
    expect(result.current_node).toBe("index");
    expect(result.ci_rounds).toBe(0);
    expect(result.lint_rounds).toBe(0);
  });

  it("trims history to entries before the first occurrence of the phase", () => {
    let state = createInitialState();
    // Manually add the index entry as runTask does, so history has a closed index entry
    state.history.push({ node: "index", entered_at: new Date().toISOString(), exited_at: null, result: null });
    state = advanceState(state, "done"); // index → plan (closes index entry, pushes plan)
    state = advanceState(state, "done"); // plan → scrutinize (closes plan, pushes scrutinize)
    const result = restartFromPhase(state, "plan");
    expect(result.current_node).toBe("plan");
    expect(result.history).toHaveLength(1);
    expect(result.history[0].node).toBe("index");
  });

  it("preserves all history when restarting a phase not in history", () => {
    const state = createInitialState(); // history is empty, current is index
    const result = restartFromPhase(state, "plan");
    expect(result.current_node).toBe("plan");
    expect(result.history).toHaveLength(0); // nothing to trim
  });

  it("throws for an unknown phase name", () => {
    const state = createInitialState();
    expect(() => restartFromPhase(state, "does_not_exist" as any)).toThrow(
      "Unknown phase: does_not_exist"
    );
  });
});

describe("restartTaskPhase — pre_plan", () => {
  let restartFn: (taskId: string, phase: string) => Promise<void>;
  let taskId: string;
  let repoId: number;

  beforeAll(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync("/tmp/hoto-test-restart-phase", { recursive: true });
    getDb();
    const mod = await import("../src/orchestrator/task-runner");
    restartFn = mod.restartTaskPhase;
  });

  beforeEach(() => {
    const db = getDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM task_repos");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM repos");
    db.exec("PRAGMA foreign_keys = ON");

    taskId = "RESTARTTEST01";
    const insertResult = db.run(
      "INSERT INTO repos (name, path) VALUES ('test-repo', '/tmp/test-repo')"
    );
    repoId = Number(insertResult.lastInsertRowid);
    db.run(
      "INSERT INTO tasks (id, title, description, status, repo_id) VALUES (?, 'Test', 'desc', 'scoping', ?)",
      [taskId, repoId]
    );
    db.run(
      "INSERT INTO task_repos (task_id, repo_id, role) VALUES (?, ?, 'target')",
      [taskId, repoId]
    );
  });

  it("clears target rows and legacy repo_id so pre-plan re-scopes on next run", async () => {
    const db = getDb();

    await restartFn(taskId, "pre_plan");

    const targetRows = db
      .query("SELECT * FROM task_repos WHERE task_id = ? AND role = 'target'")
      .all(taskId);
    expect(targetRows).toHaveLength(0);

    const taskRow = db.query("SELECT repo_id FROM tasks WHERE id = ?").get(taskId) as { repo_id: number | null };
    expect(taskRow.repo_id).toBeNull();
  });

  it("does not require any pre-existing rows to restart pre_plan", async () => {
    const db = getDb();
    db.run("DELETE FROM task_repos WHERE task_id = ?", [taskId]);
    db.run("UPDATE tasks SET repo_id = NULL WHERE id = ?", [taskId]);

    await expect(restartFn(taskId, "pre_plan")).resolves.toBeUndefined();
  });
});
