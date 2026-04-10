/**
 * Tests for child task system.
 *
 * Covers:
 *  1. Plan splitter: extract per-repo excerpts from multi-repo plans
 *  2. Child blueprint: starts at implement, has correct transitions
 *  3. Schema: child_tasks table creation and constraints
 *  4. Parent completion logic
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/knowledge/schema";
import { extractRepoExcerpts } from "../src/orchestrator/plan-splitter";
import { createChildInitialState, advanceState, getNextNode } from "../src/orchestrator/blueprint";
import type { Repo } from "../src/shared/types";

// ---------------------------------------------------------------------------
// 1. Plan splitter
// ---------------------------------------------------------------------------

function makeRepo(name: string): Repo {
  return {
    id: 1, name, path: `/tmp/${name}`,
    description: null, build_cmd: null, test_cmd: null, run_cmd: null,
    lint_cmd: null, language: null, framework: null,
    docker_compose_path: null, docker_image: null, ci_on_host: false, metadata: null,
  };
}

describe("extractRepoExcerpts", () => {
  test("splits steps by [repo-name] prefix", () => {
    const plan = [
      "### Summary",
      "Add logging to both repos.",
      "",
      "### Execution Plan",
      "1. [ ] [api] In `src/logger.ts`, add structured logging",
      "2. [ ] [frontend] In `src/utils/log.ts`, add client-side logging",
      "3. [ ] [api] In `src/server.ts`, wire up logger middleware",
    ].join("\n");

    const repos = [makeRepo("api"), makeRepo("frontend")];
    const excerpts = extractRepoExcerpts(plan, repos);

    expect(excerpts.get("api")).toContain("src/logger.ts");
    expect(excerpts.get("api")).toContain("src/server.ts");
    expect(excerpts.get("api")).not.toContain("src/utils/log.ts");

    expect(excerpts.get("frontend")).toContain("src/utils/log.ts");
    expect(excerpts.get("frontend")).not.toContain("src/logger.ts");
  });

  test("includes summary in all excerpts", () => {
    const plan = [
      "### Summary",
      "Update both repos.",
      "",
      "### Execution Plan",
      "1. [ ] [api] Fix API",
      "2. [ ] [frontend] Fix UI",
    ].join("\n");

    const repos = [makeRepo("api"), makeRepo("frontend")];
    const excerpts = extractRepoExcerpts(plan, repos);

    expect(excerpts.get("api")).toContain("Update both repos.");
    expect(excerpts.get("frontend")).toContain("Update both repos.");
  });

  test("untagged steps go to all repos", () => {
    const plan = [
      "### Summary",
      "Cross-cutting change.",
      "",
      "### Execution Plan",
      "1. [ ] Update shared config (both repos)",
      "2. [ ] [api] Fix API endpoint",
    ].join("\n");

    const repos = [makeRepo("api"), makeRepo("frontend")];
    const excerpts = extractRepoExcerpts(plan, repos);

    // Shared step should appear in both
    expect(excerpts.get("api")).toContain("Update shared config");
    expect(excerpts.get("frontend")).toContain("Update shared config");
  });

  test("handles Step N heading format", () => {
    const plan = [
      "### Summary",
      "Fix things.",
      "",
      "### Execution Plan",
      "### Step 1 -- [api] `src/foo.ts`",
      "Add error handling.",
      "",
      "### Step 2 -- [frontend] `src/bar.ts`",
      "Update UI component.",
    ].join("\n");

    const repos = [makeRepo("api"), makeRepo("frontend")];
    const excerpts = extractRepoExcerpts(plan, repos);

    expect(excerpts.get("api")).toContain("src/foo.ts");
    expect(excerpts.get("frontend")).toContain("src/bar.ts");
  });

  test("returns full plan as fallback if no repo tags found", () => {
    const plan = "### Summary\nDo stuff.\n\n### Execution Plan\n1. Fix everything.";

    const repos = [makeRepo("api")];
    const excerpts = extractRepoExcerpts(plan, repos);

    expect(excerpts.get("api")).toContain("Fix everything");
  });
});

// ---------------------------------------------------------------------------
// 2. Child blueprint
// ---------------------------------------------------------------------------

describe("child task blueprint", () => {
  test("starts at implement", () => {
    const state = createChildInitialState();
    expect(state.current_node).toBe("implement");
  });

  test("implement -> lint -> ci -> review -> commit", () => {
    let state = createChildInitialState();

    state = advanceState(state, "done"); // implement -> lint
    expect(state.current_node).toBe("lint");

    state = advanceState(state, "clean"); // lint -> ci
    expect(state.current_node).toBe("ci");

    state = advanceState(state, "pass"); // ci -> review
    expect(state.current_node).toBe("review");

    state = advanceState(state, "accept"); // review -> commit
    expect(state.current_node).toBe("commit");
  });

  test("ci failure triggers fix_ci loop", () => {
    let state = createChildInitialState();
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "fail"); // -> fix_ci
    expect(state.current_node).toBe("fix_ci");

    state = advanceState(state, "done"); // -> ci
    expect(state.current_node).toBe("ci");
  });

  test("review rejection goes through understand_review", () => {
    let state = createChildInitialState();
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review
    state = advanceState(state, "revise"); // -> understand_review
    expect(state.current_node).toBe("understand_review");

    // Small path
    state = advanceState(state, "small"); // -> review_small_feedback
    expect(state.current_node).toBe("review_small_feedback");
    state = advanceState(state, "done"); // -> implement
    expect(state.current_node).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// 3. Schema
// ---------------------------------------------------------------------------

describe("child_tasks schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterAll(() => {
    db.close();
  });

  test("child_tasks table exists", () => {
    // Create a parent task first
    db.run("INSERT INTO tasks (id, title, description, status) VALUES ('parent1', 'Test', 'desc', 'waiting_for_children')");
    db.run("INSERT INTO repos (name, path) VALUES ('test-repo', '/tmp/test')");

    const repoId = (db.query("SELECT id FROM repos WHERE name = 'test-repo'").get() as { id: number }).id;

    db.run(
      "INSERT INTO child_tasks (id, parent_task_id, repo_id, plan_excerpt) VALUES ('child1', 'parent1', ?, 'fix stuff')",
      [repoId]
    );

    const row = db.query("SELECT * FROM child_tasks WHERE id = 'child1'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.parent_task_id).toBe("parent1");
    expect(row.status).toBe("pending");
    expect(row.plan_excerpt).toBe("fix stuff");
  });

  test("unique constraint on (parent_task_id, repo_id)", () => {
    const repoId = (db.query("SELECT id FROM repos WHERE name = 'test-repo'").get() as { id: number }).id;

    expect(() => {
      db.run(
        "INSERT INTO child_tasks (id, parent_task_id, repo_id, plan_excerpt) VALUES ('child2', 'parent1', ?, 'dup')",
        [repoId]
      );
    }).toThrow();
  });

  test("cascade delete when parent task deleted", () => {
    db.run("DELETE FROM tasks WHERE id = 'parent1'");
    const row = db.query("SELECT * FROM child_tasks WHERE id = 'child1'").get();
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Blueprint node transitions for child-relevant nodes
// ---------------------------------------------------------------------------

describe("child-relevant node transitions", () => {
  test("implement.error goes to review", () => {
    expect(getNextNode("implement", "error")).toBe("review");
  });

  test("fix_ci.done goes back to ci", () => {
    expect(getNextNode("fix_ci", "done")).toBe("ci");
  });

  test("fix_lint.done goes back to lint", () => {
    expect(getNextNode("fix_lint", "done")).toBe("lint");
  });

  test("review.accept goes to commit", () => {
    expect(getNextNode("review", "accept")).toBe("commit");
  });
});
