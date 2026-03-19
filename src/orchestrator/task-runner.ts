import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import type { Task, Repo, BlueprintState, TaskStatus } from "../shared/types";
import { createInitialState, advanceState } from "./blueprint";
import { executePlan } from "./nodes/agentic/plan";
import { executeImplement } from "./nodes/agentic/implement";
import { executeFixLint } from "./nodes/agentic/fix-lint";
import { executeFixCi } from "./nodes/agentic/fix-ci";
import { executeLint } from "./nodes/deterministic/lint";
import { rm } from "node:fs/promises";
import { createWorktree, generateBranchName, removeWorktree } from "../workspace/git";
import { ensureTaskDir, taskDir, worktreeDir } from "../workspace/manager";
import { killTaskSubprocesses } from "./subprocess-registry";
import { indexRepo } from "../knowledge/indexer";
import { generateMcpConfig } from "./subprocess";
import { setupTaskContainer, teardownTaskContainer } from "../workspace/docker-exec";
import { $ } from "bun";

const MAX_LINT_ROUNDS = 1;
const MAX_CI_ROUNDS = 2;

function updateTaskStatus(taskId: string, status: TaskStatus, blueprintState?: BlueprintState) {
  const db = getDb();
  const now = new Date().toISOString();
  if (blueprintState) {
    db.run(
      "UPDATE tasks SET status = ?, blueprint_state = ?, updated_at = ? WHERE id = ?",
      [status, JSON.stringify(blueprintState), now, taskId]
    );
  } else {
    db.run(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
      [status, now, taskId]
    );
  }
}

function updateTaskBranch(taskId: string, branchName: string) {
  const db = getDb();
  db.run("UPDATE tasks SET branch_name = ? WHERE id = ?", [branchName, taskId]);
}

function isTaskCancelled(taskId: string): boolean {
  const db = getDb();
  const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
  return row?.status === "cancelled";
}

export async function cleanupTask(taskId: string): Promise<void> {
  // Kill any running subprocesses for this task
  killTaskSubprocesses(taskId);

  // Tear down Docker container if one exists
  try {
    await teardownTaskContainer(taskId);
  } catch (err) {
    logger.warn("Docker teardown failed", { taskId, error: String(err) });
  }

  const db = getDb();

  // Mark any still-running agent_runs as failed
  db.run(
    "UPDATE agent_runs SET status = 'failed', error = 'task cancelled', finished_at = datetime('now') WHERE task_id = ? AND status = 'running'",
    [taskId]
  );

  // Look up task and repo to find the worktree
  const taskRow = db.query("SELECT branch_name, repo_id FROM tasks WHERE id = ?").get(taskId) as {
    branch_name: string | null;
    repo_id: number | null;
  } | null;

  if (!taskRow || !taskRow.repo_id || !taskRow.branch_name) {
    logger.info("No worktree to clean up", { taskId });
    return;
  }

  const repoRow = db.query("SELECT path, name FROM repos WHERE id = ?").get(taskRow.repo_id) as {
    path: string;
    name: string;
  } | null;

  if (!repoRow) {
    logger.warn("Repo not found during cleanup", { taskId, repoId: taskRow.repo_id });
    return;
  }

  const wtDir = worktreeDir(taskId, repoRow.name);

  // Remove git worktree
  try {
    await removeWorktree(repoRow.path, wtDir);
    logger.info("Removed worktree", { taskId, wtDir });
  } catch (err) {
    logger.warn("Failed to remove worktree (may not exist)", { taskId, wtDir, error: String(err) });
  }

  // Delete the branch
  try {
    await $`git -C ${repoRow.path} branch -D ${taskRow.branch_name}`.quiet().nothrow();
    logger.info("Deleted branch", { taskId, branch: taskRow.branch_name });
  } catch (err) {
    logger.warn("Failed to delete branch", { taskId, branch: taskRow.branch_name, error: String(err) });
  }

  // Remove the task directory (MCP config, logs, etc.)
  try {
    const tDir = taskDir(taskId);
    await rm(tDir, { recursive: true, force: true });
    logger.info("Removed task directory", { taskId, dir: tDir });
  } catch (err) {
    logger.warn("Failed to remove task directory", { taskId, error: String(err) });
  }
}

function loadTaskAndRepo(taskId: string): { task: Task; repo: Repo } | null {
  const db = getDb();

  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null;
  if (!taskRow) return null;

  const repoRow = taskRow.repo_id
    ? (db.query("SELECT * FROM repos WHERE id = ?").get(taskRow.repo_id as number) as Record<string, unknown> | null)
    : null;
  if (!repoRow) return null;

  const task: Task = {
    id: taskRow.id as string,
    title: taskRow.title as string,
    description: taskRow.description as string,
    repo_id: taskRow.repo_id as number,
    status: taskRow.status as TaskStatus,
    blueprint_state: null,
    branch_name: taskRow.branch_name as string | null,
    source: taskRow.source as "cli" | "web",
    created_at: taskRow.created_at as string,
    updated_at: taskRow.updated_at as string,
  };

  const repo: Repo = {
    id: repoRow.id as number,
    name: repoRow.name as string,
    path: repoRow.path as string,
    description: repoRow.description as string | null,
    build_cmd: repoRow.build_cmd as string | null,
    test_cmd: repoRow.test_cmd as string | null,
    run_cmd: repoRow.run_cmd as string | null,
    lint_cmd: repoRow.lint_cmd as string | null,
    language: repoRow.language as string | null,
    framework: repoRow.framework as string | null,
    docker_compose_path: repoRow.docker_compose_path as string | null,
    metadata: null,
  };

  return { task, repo };
}

export async function runTask(taskId: string): Promise<void> {
  const loaded = loadTaskAndRepo(taskId);
  if (!loaded) {
    logger.error("Task or repo not found", { taskId });
    updateTaskStatus(taskId, "failed");
    return;
  }

  const { task, repo } = loaded;

  // Set up worktree
  const branchName = generateBranchName(task.id, task.title);
  updateTaskBranch(task.id, branchName);

  let workDir: string;
  try {
    await ensureTaskDir(task.id);
    workDir = await createWorktree(repo.path, task.id, repo.name, branchName);
  } catch (err) {
    logger.error("Failed to create worktree", { error: String(err) });
    updateTaskStatus(task.id, "failed");
    return;
  }

  // Generate MCP config for agent nodes
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(task.id, workDir, repo.name);
  } catch (err) {
    logger.warn("Failed to generate MCP config, agents will use direct tools", { error: String(err) });
  }

  // Set up Docker container if applicable
  let containerName: string | null = null;
  try {
    containerName = await setupTaskContainer(repo, workDir, task.id);
    if (containerName) {
      logger.info("Docker container ready", { taskId: task.id, containerName });
    }
  } catch (err) {
    logger.warn("Docker setup failed, running locally", { error: String(err) });
  }

  let state = createInitialState();
  state.history.push({
    node: "index",
    entered_at: new Date().toISOString(),
    exited_at: null,
    result: null,
  });

  // === INDEX ===
  updateTaskStatus(task.id, "indexing", state);
  logger.info("Starting index phase", { taskId: task.id });

  try {
    await indexRepo(repo);
    state = advanceState(state, "done");
  } catch (err) {
    logger.warn("Repo reindex failed, continuing", { error: String(err) });
    state = advanceState(state, "error");
  }

  if (isTaskCancelled(task.id)) return;

  // === PLAN ===
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting plan phase", { taskId: task.id });

  const planResult = await executePlan(task, repo, workDir, mcpConfigPath);

  if (planResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Planning failed", { taskId: task.id, error: planResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === IMPLEMENT ===
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "implementing", state);
  logger.info("Starting implement phase", { taskId: task.id });

  const implResult = await executeImplement(task, repo, workDir, planResult.plan, mcpConfigPath);

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === LINT (with fix loop) ===
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "linting", state);

  if (repo.lint_cmd) {
    let _lintPassed = false;

    for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
      logger.info("Running lint", { taskId: task.id, round });

      const lintResult = await executeLint(repo, workDir, containerName ?? undefined);

      if (lintResult.success) {
        _lintPassed = true;
        break;
      }

      if (round >= MAX_LINT_ROUNDS) {
        logger.warn("Lint fix limit reached, proceeding anyway", { taskId: task.id });
        break;
      }

      if (isTaskCancelled(task.id)) return;

      // Fix lint errors
      state = advanceState(state, "errors");
      updateTaskStatus(task.id, "linting", state);
      logger.info("Running fix-lint agent", { taskId: task.id, round });

      const fixResult = await executeFixLint(
        task, repo, workDir,
        lintResult.output, lintResult.command, mcpConfigPath
      );

      if (fixResult.error) {
        if (isTaskCancelled(task.id)) return;
        logger.warn("Fix-lint failed", { taskId: task.id, error: fixResult.error });
        break;
      }

      // Loop back to lint
      state = advanceState(state, "done");
      state.lint_rounds++;
    }
  }

  if (isTaskCancelled(task.id)) return;

  // === CI (test/build with fix loop) ===
  if (repo.test_cmd || repo.build_cmd) {
    state = advanceState(state, "clean");
    updateTaskStatus(task.id, "ci_running", state);

    for (let round = 0; round < MAX_CI_ROUNDS; round++) {
      logger.info("Running CI", { taskId: task.id, round });

      const ciResult = await runCi(repo, workDir, containerName ?? undefined);

      if (ciResult.success) {
        state = advanceState(state, "pass");
        break;
      }

      if (round >= MAX_CI_ROUNDS - 1) {
        logger.warn("CI fix limit reached", { taskId: task.id });
        state = advanceState(state, "pass"); // proceed to review with failure noted
        break;
      }

      if (isTaskCancelled(task.id)) return;

      // Fix CI
      state = advanceState(state, "fail");
      updateTaskStatus(task.id, "ci_fixing", state);
      logger.info("Running fix-ci agent", { taskId: task.id, round });

      const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, mcpConfigPath);

      if (fixResult.error) {
        if (isTaskCancelled(task.id)) return;
        logger.warn("Fix-ci failed", { taskId: task.id, error: fixResult.error });
        state = advanceState(state, "error");
        break;
      }

      state = advanceState(state, "done");
      state.ci_rounds++;

      updateTaskStatus(task.id, "ci_running", state);
    }
  } else {
    // No CI configured, skip to review
    state = advanceState(state, "clean");
  }

  // Tear down Docker container before review (no longer needed)
  if (containerName) {
    try {
      await teardownTaskContainer(task.id);
      logger.info("Docker container torn down after CI", { taskId: task.id });
    } catch (err) {
      logger.warn("Docker teardown failed", { taskId: task.id, error: String(err) });
    }
  }

  // === REVIEW ===
  updateTaskStatus(task.id, "review", state);
  logger.info("Task ready for review", { taskId: task.id });
}

async function runCi(
  repo: Repo,
  workDir: string,
  containerName?: string
): Promise<{ success: boolean; output: string }> {
  const commands: string[] = [];
  if (repo.build_cmd) commands.push(repo.build_cmd);
  if (repo.test_cmd) commands.push(repo.test_cmd);

  let allOutput = "";
  for (const cmd of commands) {
    logger.info("Running CI command", { cmd, containerName });
    try {
      const result = containerName
        ? await $`docker exec -w /workspace ${containerName} sh -c ${cmd}`.quiet().nothrow()
        : await $`sh -c ${cmd}`.cwd(workDir).quiet().nothrow();
      const output = result.stdout.toString() + result.stderr.toString();
      allOutput += `\n$ ${cmd}\n${output}`;

      if (result.exitCode !== 0) {
        return { success: false, output: allOutput };
      }
    } catch (err) {
      allOutput += `\n$ ${cmd}\nError: ${err}`;
      return { success: false, output: allOutput };
    }
  }

  return { success: true, output: allOutput };
}
