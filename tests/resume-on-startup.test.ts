import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Set isolated workspace BEFORE any imports that load config/db
process.env.HOTO_WORKSPACE = path.join(os.tmpdir(), `hoto-test-${crypto.randomUUID()}`);

import { describe, it, expect, afterEach } from "bun:test";
import { getDb } from "../src/knowledge/db";
import { resumeInterruptedTasks, type ResumeHandlers } from "../src/orchestrator/resume-on-startup";

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM child_tasks");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM repos");
}

const restartTaskPhaseCalls: Array<{ taskId: string; phase: string }> = [];
const restartChildTaskPhaseCalls: Array<{ taskId: string; childId: string; phase: string }> = [];

function makeHandlers(): ResumeHandlers {
  return {
    restartTaskPhase: async (taskId: string, phase: string) => {
      restartTaskPhaseCalls.push({ taskId, phase });
    },
    restartChildTaskPhase: async (taskId: string, childId: string, phase: string) => {
      restartChildTaskPhaseCalls.push({ taskId, childId, phase });
    },
    staggerMs: 0, // no delay in tests
  };
}

afterEach(() => {
  clearTables();
  restartTaskPhaseCalls.length = 0;
  restartChildTaskPhaseCalls.length = 0;
});

function seedRepo() {
  const db = getDb();
  db.run("INSERT INTO repos (id, name, path, description) VALUES (1, 'test-repo', '/tmp/test-repo', 'Test')");
}

function seedTask(id: string, status: string, blueprintState?: object) {
  const db = getDb();
  db.run(
    `INSERT INTO tasks (id, title, description, repo_id, status, source, blueprint_state)
     VALUES (?, 'Test task', 'A test', 1, ?, 'cli', ?)`,
    [id, status, blueprintState ? JSON.stringify(blueprintState) : null]
  );
}

function seedChildTask(id: string, parentId: string, status: string, blueprintState?: object) {
  const db = getDb();
  db.run(
    `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, branch_name, plan_excerpt, blueprint_state)
     VALUES (?, ?, 1, ?, 'test-branch', 'test plan', ?)`,
    [id, parentId, status, blueprintState ? JSON.stringify(blueprintState) : null]
  );
}

describe("resumeInterruptedTasks", () => {
  it("does nothing when no interrupted tasks exist", async () => {
    seedRepo();
    seedTask("task-1", "committed");
    seedTask("task-2", "cancelled");
    seedTask("task-3", "error");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(0);
    expect(restartChildTaskPhaseCalls).toHaveLength(0);
  });

  it("resumes a task in planning status from its blueprint resume point", async () => {
    seedRepo();
    const bp = {
      current_node: "plan",
      history: [
        { node: "index", entered_at: "2026-01-01T00:00:00Z", exited_at: "2026-01-01T00:01:00Z", result: "done" },
        { node: "plan", entered_at: "2026-01-01T00:01:00Z", exited_at: null, result: null },
      ],
      ci_rounds: 0,
      lint_rounds: 0,
    };
    seedTask("task-planning", "planning", bp);

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].taskId).toBe("task-planning");
    expect(restartTaskPhaseCalls[0].phase).toBe("plan");
  });

  it("resumes early-phase tasks from index", async () => {
    seedRepo();
    seedTask("task-pending", "pending");
    seedTask("task-indexing", "indexing");
    seedTask("task-scoping", "scoping");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(3);
    for (const call of restartTaskPhaseCalls) {
      expect(call.phase).toBe("index");
    }
  });

  it("resumes spawning_children from finalize_plan", async () => {
    seedRepo();
    seedTask("task-spawning", "spawning_children");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("finalize_plan");
  });

  it("skips parent in waiting_for_children but resumes its interrupted children", async () => {
    seedRepo();
    seedTask("parent-1", "waiting_for_children");
    seedChildTask("child-1", "parent-1", "implementing", {
      current_node: "implement",
      history: [
        { node: "implement", entered_at: "2026-01-01T00:00:00Z", exited_at: null, result: null },
      ],
      ci_rounds: 0,
      lint_rounds: 0,
    });

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(0);
    expect(restartChildTaskPhaseCalls).toHaveLength(1);
    expect(restartChildTaskPhaseCalls[0].childId).toBe("child-1");
    expect(restartChildTaskPhaseCalls[0].phase).toBe("implement");
  });

  it("does not resume child tasks whose parent is cancelled", async () => {
    seedRepo();
    seedTask("parent-cancelled", "cancelled");
    seedChildTask("child-orphan", "parent-cancelled", "implementing");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartChildTaskPhaseCalls).toHaveLength(0);
  });

  it("does not resume child tasks whose parent is failed", async () => {
    seedRepo();
    seedTask("parent-failed", "failed");
    seedChildTask("child-orphan", "parent-failed", "linting");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartChildTaskPhaseCalls).toHaveLength(0);
  });

  it("derives resume phase from status when no blueprint_state is saved (planning)", async () => {
    seedRepo();
    seedTask("task-no-bp-planning", "planning");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("plan");
  });

  it("derives resume phase from status when no blueprint_state is saved (implementing)", async () => {
    seedRepo();
    seedTask("task-no-bp-implementing", "implementing");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("implement");
  });

  it("derives resume phase from status when no blueprint_state is saved (ci_running)", async () => {
    seedRepo();
    seedTask("task-no-bp-ci", "ci_running");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("ci");
  });

  it("falls back to index for resuming status when no blueprint_state is saved", async () => {
    seedRepo();
    seedTask("task-no-bp-resuming", "resuming");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("index");
  });

  it("defaults child to implement when no blueprint_state is saved", async () => {
    seedRepo();
    seedTask("parent-2", "waiting_for_children");
    seedChildTask("child-no-bp", "parent-2", "implementing");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartChildTaskPhaseCalls).toHaveLength(1);
    expect(restartChildTaskPhaseCalls[0].phase).toBe("implement");
  });

  it("does not resume tasks in terminal statuses", async () => {
    seedRepo();
    seedTask("t-committed", "committed");
    seedTask("t-error", "error");
    seedTask("t-failed", "failed");
    seedTask("t-cancelled", "cancelled");
    seedTask("t-review", "review");
    seedTask("t-accepted", "accepted");

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(0);
    expect(restartChildTaskPhaseCalls).toHaveLength(0);
  });

  it("resumes scrutinizing task from its interrupted phase", async () => {
    seedRepo();
    const bp = {
      current_node: "scrutinize",
      history: [
        { node: "index", entered_at: "2026-01-01T00:00:00Z", exited_at: "2026-01-01T00:01:00Z", result: "done" },
        { node: "plan", entered_at: "2026-01-01T00:01:00Z", exited_at: "2026-01-01T00:05:00Z", result: "done" },
        { node: "scrutinize", entered_at: "2026-01-01T00:05:00Z", exited_at: null, result: null },
      ],
      ci_rounds: 0,
      lint_rounds: 0,
    };
    seedTask("task-scrutinize", "scrutinizing", bp);

    await resumeInterruptedTasks(makeHandlers());

    expect(restartTaskPhaseCalls).toHaveLength(1);
    expect(restartTaskPhaseCalls[0].phase).toBe("scrutinize");
  });

  it("resumes multiple children of the same parent independently", async () => {
    seedRepo();
    const db = getDb();
    db.run("INSERT INTO repos (id, name, path, description) VALUES (2, 'test-repo-2', '/tmp/test-repo-2', 'Test 2')");
    db.run("INSERT INTO repos (id, name, path, description) VALUES (3, 'test-repo-3', '/tmp/test-repo-3', 'Test 3')");
    seedTask("parent-multi", "waiting_for_children");
    seedChildTask("child-a", "parent-multi", "implementing");

    // child-b uses repo 2
    db.run(
      `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, branch_name, plan_excerpt, blueprint_state)
       VALUES ('child-b', 'parent-multi', 2, 'linting', 'test-branch', 'test plan', ?)`,
      [JSON.stringify({
        current_node: "lint",
        history: [
          { node: "implement", entered_at: "2026-01-01T00:00:00Z", exited_at: "2026-01-01T00:05:00Z", result: "done" },
          { node: "lint", entered_at: "2026-01-01T00:05:00Z", exited_at: null, result: null },
        ],
        ci_rounds: 0,
        lint_rounds: 0,
      })]
    );

    // child-c is committed -- should NOT be resumed (uses repo 3)
    db.run(
      `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, branch_name, plan_excerpt)
       VALUES ('child-c', 'parent-multi', 3, 'committed', 'test-branch', 'test plan')`
    );

    await resumeInterruptedTasks(makeHandlers());

    expect(restartChildTaskPhaseCalls).toHaveLength(2);
    const phases = restartChildTaskPhaseCalls.map((c) => ({ id: c.childId, phase: c.phase }));
    expect(phases).toContainEqual({ id: "child-a", phase: "implement" });
    expect(phases).toContainEqual({ id: "child-b", phase: "lint" });
  });
});
