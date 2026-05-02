import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { getDb } from "../src/knowledge/db";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-projects-runner";

// Stub the revisor: return null (= no revision applied) so tests focus on the
// runner's own milestone advancement logic. The revisor is exercised
// separately in tests/project-revisor.test.ts. We preserve real exports for
// other tests that load this module concurrently.
const realRevisor = await import("../src/projects/revisor");
mock.module("../src/projects/revisor", () => ({
  ...realRevisor,
  reviseRemainingMilestones: async () => null,
}));

// Intercept fetch before runner is imported so advanceProject does not need a live daemon
const originalFetch = globalThis.fetch;
let lastFetchUrl = "";
let lastFetchBody: Record<string, unknown> | null = null;
let mockTaskIdCounter = 0;
let fetchShouldFail = false;

const fakeFetch = async (url: string, opts?: RequestInit): Promise<Response> => {
  lastFetchUrl = url as string;
  lastFetchBody = opts?.body ? JSON.parse(opts.body as string) : null;
  if (fetchShouldFail) {
    return new Response("internal error", { status: 500 });
  }
  mockTaskIdCounter += 1;
  return new Response(JSON.stringify({ id: `mock-task-${mockTaskIdCounter}` }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};

globalThis.fetch = fakeFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

let onTaskCompleted: (taskId: string) => Promise<void>;
let resumeProjects: () => Promise<void>;
let advanceProject: (projectId: string) => Promise<void>;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-projects-runner", { recursive: true });
  getDb();

  const runner = await import("../src/projects/runner");
  onTaskCompleted = runner.onTaskCompleted;
  resumeProjects = runner.resumeProjects;
  advanceProject = runner.advanceProject;
});

function makeMillestones(n: number, currentTaskId: string | null = null) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    description: `Milestone ${i + 1}`,
    task_id: i === 0 ? currentTaskId : null,
    completed: false,
  }));
}

function insertProject(
  id: string,
  milestones: unknown[],
  currentMilestone: number,
  status: string,
  sourceSenderId: string | null = null,
  sourceProvider: string | null = null,
) {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects (id, title, description, status, milestones, current_milestone, source_sender_id, source_provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "Test Project", "test desc", status, JSON.stringify(milestones), currentMilestone, sourceSenderId, sourceProvider, now, now],
  );
}

function getProjectRow(id: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return { ...row, milestones: JSON.parse(row.milestones as string) as Array<Record<string, unknown>> };
}

function clearDb() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM agent_runs");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM projects");
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  clearDb();
  lastFetchUrl = "";
  lastFetchBody = null;
  fetchShouldFail = false;
  mockTaskIdCounter = 0;
});

describe("onTaskCompleted", () => {
  test("does nothing when no in_progress project references the task", async () => {
    insertProject("proj-1", makeMillestones(2, "task-other"), 0, "in_progress");
    await onTaskCompleted("task-nonexistent");
    const project = getProjectRow("proj-1");
    expect(project?.status).toBe("in_progress");
    expect(project?.current_milestone).toBe(0);
    expect((project?.milestones as Array<Record<string, unknown>>)[0].completed).toBe(false);
  });

  test("advances current_milestone and calls advanceProject when intermediate milestone completes", async () => {
    const milestones = makeMillestones(2, "task-1");
    insertProject("proj-2", milestones, 0, "in_progress");

    await onTaskCompleted("task-1");

    const project = getProjectRow("proj-2");
    expect(project?.current_milestone).toBe(1);
    expect((project?.milestones as Array<Record<string, unknown>>)[0].completed).toBe(true);
    expect(project?.status).toBe("in_progress");
    // advanceProject should have fired a fetch to create the next task
    expect(lastFetchUrl).toContain("/tasks");
    expect(lastFetchBody?.description).toContain("Milestone 2");
  });

  test("marks project as completed when last milestone finishes", async () => {
    const milestones = [
      { index: 0, description: "Milestone 1", task_id: "task-done", completed: true },
      { index: 1, description: "Milestone 2", task_id: "task-2", completed: false },
    ];
    insertProject("proj-3", milestones, 1, "in_progress");

    await onTaskCompleted("task-2");

    const project = getProjectRow("proj-3");
    expect(project?.status).toBe("completed");
    expect((project?.milestones as Array<Record<string, unknown>>)[1].completed).toBe(true);
    expect(project?.current_milestone).toBe(2);
    // No further task should be created
    expect(lastFetchUrl).toBe("");
  });

  test("captures carry_over_notes from latest completed agent run", async () => {
    const db = getDb();
    const milestones = makeMillestones(2, "task-carry");
    insertProject("proj-4", milestones, 0, "in_progress");

    // Insert a task and a completed agent run with output
    db.run(
      "INSERT INTO tasks (id, title, description, status, source) VALUES (?, ?, ?, ?, ?)",
      ["task-carry", "Task", "desc", "committed", "cli"],
    );
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, output, model, started_at, finished_at)
       VALUES (?, ?, 'implement', 'claude', 'completed', 'test', ?, 'test', datetime('now'), datetime('now'))`,
      ["run-1", "task-carry", "Important carry-over context from this milestone."],
    );

    await onTaskCompleted("task-carry");

    const project = getProjectRow("proj-4");
    expect(typeof project?.carry_over_notes).toBe("string");
    expect((project?.carry_over_notes as string).length).toBeGreaterThan(0);
  });

  test("does nothing when project is not in_progress status", async () => {
    const milestones = makeMillestones(2, "task-done");
    insertProject("proj-5", milestones, 0, "completed");

    await onTaskCompleted("task-done");

    const project = getProjectRow("proj-5");
    // Status should remain completed, not change
    expect(project?.status).toBe("completed");
  });
});

describe("resumeProjects", () => {
  test("retries task creation when milestone.task_id is null", async () => {
    const milestones = makeMillestones(2, null);
    insertProject("proj-6", milestones, 0, "in_progress");

    await resumeProjects();

    // advanceProject should have been called, which POSTs to /tasks
    expect(lastFetchUrl).toContain("/tasks");

    // The milestone task_id should now be set
    const project = getProjectRow("proj-6");
    expect((project?.milestones as Array<Record<string, unknown>>)[0].task_id).toBe("mock-task-1");
  });

  test("calls onTaskCompleted when task status is already committed", async () => {
    const db = getDb();
    const milestones = makeMillestones(2, "task-already-done");
    insertProject("proj-7", milestones, 0, "in_progress");

    db.run(
      "INSERT INTO tasks (id, title, description, status, source) VALUES (?, ?, ?, ?, ?)",
      ["task-already-done", "Task", "desc", "committed", "cli"],
    );

    await resumeProjects();

    const project = getProjectRow("proj-7");
    // onTaskCompleted should have fired: milestone 0 completed, moved to milestone 1
    expect((project?.milestones as Array<Record<string, unknown>>)[0].completed).toBe(true);
    expect(project?.current_milestone).toBe(1);
  });

  test("skips projects that are not in_progress", async () => {
    const milestones = makeMillestones(1, null);
    insertProject("proj-8", milestones, 0, "failed");

    await resumeProjects();

    // No fetch should have been made since project is not in_progress
    expect(lastFetchUrl).toBe("");
  });
});

describe("advanceProject", () => {
  test("creates a task via fetch and saves task_id to the milestone", async () => {
    const milestones = makeMillestones(1, null);
    insertProject("proj-9", milestones, 0, "in_progress");

    await advanceProject("proj-9");

    expect(lastFetchUrl).toContain("/tasks");
    const project = getProjectRow("proj-9");
    expect((project?.milestones as Array<Record<string, unknown>>)[0].task_id).toBe("mock-task-1");
  });

  test("leaves task_id null when fetch fails", async () => {
    fetchShouldFail = true;
    const milestones = makeMillestones(1, null);
    insertProject("proj-10", milestones, 0, "in_progress");

    // Should not throw — logs warning and returns
    await advanceProject("proj-10");

    const project = getProjectRow("proj-10");
    expect((project?.milestones as Array<Record<string, unknown>>)[0].task_id).toBeNull();
  });

  test("does nothing when project is not in_progress", async () => {
    const milestones = makeMillestones(1, null);
    insertProject("proj-11", milestones, 0, "completed");

    await advanceProject("proj-11");

    expect(lastFetchUrl).toBe("");
  });
});
