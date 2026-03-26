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
import { createTaskClone, removeTaskClone, generateBranchName } from "../workspace/git";
import { ensureTaskDir, taskDir, worktreeDir } from "../workspace/manager";
import { killTaskSubprocesses } from "./subprocess-registry";
import { indexRepo } from "../knowledge/indexer";
import { generateMcpConfig } from "./subprocess";
import { setupTaskContainer, teardownTaskContainer } from "../workspace/docker-exec";
import { discoverSecrets } from "../workspace/secret-discovery";
import { getMessagingManager } from "../messaging/manager";
import { indexTaskChatHistory } from "../messaging/indexer";
import { isGiteaConfigured, createPullRequest, updatePullRequest, rewriteGiteaUrl } from "../gitea/client";
import { ensureRepoOnGitea, pushBranchToGitea } from "../gitea/repo-sync";
import { startReviewPoller, seedCursors } from "../gitea/review-poller";
import { $ } from "bun";

const MAX_LINT_ROUNDS = 1;
const MAX_CI_ROUNDS = 2;
const INPUT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INPUT_POLL_INTERVAL_MS = 2000;

import type { MessagingManager } from "../messaging/manager";

/**
 * Create an onEvent callback that buffers text/thinking deltas and
 * flushes them to the task chat periodically (avoids flooding with per-token messages).
 */
function makeThinkingForwarder(
  taskId: string,
  manager: MessagingManager | null
): (type: string, content: string) => void {
  if (!manager) return () => {};

  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_INTERVAL_MS = 2000;

  const flush = () => {
    if (buffer.trim()) {
      const msg = buffer;
      buffer = "";
      manager.notifyAgentOutput(taskId, msg).catch(() => {});
    }
    flushTimer = null;
  };

  return (type, content) => {
    if (!content) return;
    if (type === "thinking" || type === "text") {
      buffer += content;
      if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    }
    // Flush on tool boundaries so the user sees reasoning before a tool call
    if (type === "tool_use" || type === "tool_result") {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    }
  };
}

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

  // Notify messaging provider
  const manager = getMessagingManager();
  if (manager) {
    const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null;
    if (taskRow) {
      const task = {
        id: taskRow.id as string,
        title: taskRow.title as string,
        description: taskRow.description as string,
        repo_id: taskRow.repo_id as number | null,
        status: status,
        blueprint_state: null,
        branch_name: taskRow.branch_name as string | null,
        source: taskRow.source as "cli" | "web",
        use_full_copy: !!(taskRow.use_full_copy as number),
        created_at: taskRow.created_at as string,
        updated_at: now,
      };
      manager.notifyTaskStatusChange(task, status).catch(() => {});
    }
  }
}

function updateTaskBranch(taskId: string, branchName: string) {
  const db = getDb();
  db.run("UPDATE tasks SET branch_name = ? WHERE id = ?", [branchName, taskId]);
}

function saveNodeOutput(
  taskId: string,
  node: "lint" | "ci",
  output: string,
  passed: boolean
) {
  const db = getDb();
  if (node === "lint") {
    db.run(
      "UPDATE tasks SET lint_output = ?, lint_passed = ? WHERE id = ?",
      [output, passed ? 1 : 0, taskId]
    );
  } else {
    db.run(
      "UPDATE tasks SET ci_output = ?, ci_passed = ? WHERE id = ?",
      [output, passed ? 1 : 0, taskId]
    );
  }
}

export async function requestHumanInput(taskId: string, question: string): Promise<string> {
  const db = getDb();
  const requestId = (await import("ulid")).ulid();

  db.run(
    "INSERT INTO task_input_requests (id, task_id, question, status) VALUES (?, ?, ?, 'pending')",
    [requestId, taskId, question]
  );

  // Update task status
  updateTaskStatus(taskId, "waiting_for_input");

  // Notify via messaging if available
  try {
    const { getMessagingManager } = await import("../messaging/manager");
    const manager = getMessagingManager();
    if (manager) {
      await manager.notifyInputRequest(taskId, question);
    }
  } catch {
    // Messaging not configured
  }

  logger.info("Waiting for human input", { taskId, requestId, question });

  // Poll for answer
  const startTime = Date.now();
  while (Date.now() - startTime < INPUT_TIMEOUT_MS) {
    const row = db.query(
      "SELECT answer, status FROM task_input_requests WHERE id = ?"
    ).get(requestId) as { answer: string | null; status: string } | null;

    if (row?.status === "answered" && row.answer) {
      logger.info("Human input received", { taskId, requestId });
      return row.answer;
    }

    if (isTaskCancelled(taskId)) {
      throw new Error("Task cancelled while waiting for input");
    }

    await new Promise((r) => setTimeout(r, INPUT_POLL_INTERVAL_MS));
  }

  // Timeout -- mark as timed out and return default
  db.run("UPDATE task_input_requests SET status = 'timeout' WHERE id = ?", [requestId]);
  logger.warn("Human input timed out", { taskId, requestId });
  return "No response received. Proceed with your best judgment.";
}

function generatePrMetadata(
  task: Task,
  planOutput: string,
  diffStat: string,
  lintPassed: boolean | null,
  ciPassed: boolean | null
): { title: string; body: string } {
  // Derive title: first non-empty line from planOutput that looks like a heading or summary.
  // Strip leading # markers and whitespace. Fall back to task.title. Trim to 72 chars.
  let title = task.title;
  const lines = planOutput.split("\n");
  for (const line of lines) {
    const stripped = line.replace(/^#+\s*/, "").trim();
    if (stripped.length > 0) {
      title = stripped.length > 72 ? stripped.slice(0, 72) : stripped;
      break;
    }
  }

  // Derive summary: first paragraph or content up to ~500 chars from planOutput.
  const paragraphs = planOutput.split(/\n\n+/);
  const summaryRaw = paragraphs[0] ?? "";
  const summary = summaryRaw.length > 500 ? `${summaryRaw.slice(0, 500)}...` : summaryRaw;

  // Truncate plan to ~3000 chars.
  const planTruncated = planOutput.length > 3000
    ? `${planOutput.slice(0, 3000)}\n...(truncated)`
    : planOutput;

  const lintStatus = lintPassed === null ? "skipped" : lintPassed ? "passed" : "failed";
  const ciStatus = ciPassed === null ? "skipped" : ciPassed ? "passed" : "failed";

  const bodyParts: string[] = [];

  if (summary) {
    bodyParts.push(summary);
    bodyParts.push("");
  }

  if (diffStat) {
    bodyParts.push("## Changes");
    bodyParts.push(diffStat);
    bodyParts.push("");
  }

  bodyParts.push("## Plan");
  bodyParts.push(planTruncated);
  bodyParts.push("");
  bodyParts.push("---");
  bodyParts.push(`Task ID: \`${task.id}\``);
  bodyParts.push(`Lint: ${lintStatus}`);
  bodyParts.push(`CI: ${ciStatus}`);

  return { title, body: bodyParts.join("\n") };
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

  // Remove the task directory (clone, MCP config, logs, etc.)
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
    use_full_copy: !!(taskRow.use_full_copy as number),
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

function parseRepoRow(row: Record<string, unknown>): Repo {
  return {
    id: row.id as number,
    name: row.name as string,
    path: row.path as string,
    description: row.description as string | null,
    build_cmd: row.build_cmd as string | null,
    test_cmd: row.test_cmd as string | null,
    run_cmd: row.run_cmd as string | null,
    lint_cmd: row.lint_cmd as string | null,
    language: row.language as string | null,
    framework: row.framework as string | null,
    docker_compose_path: row.docker_compose_path as string | null,
    metadata: null,
  };
}

function parseTaskRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    repo_id: row.repo_id as number | null,
    status: row.status as TaskStatus,
    blueprint_state: null,
    branch_name: row.branch_name as string | null,
    source: row.source as "cli" | "web",
    use_full_copy: !!(row.use_full_copy as number),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function loadTaskAndRepos(taskId: string): { task: Task; repos: Repo[] } | null {
  const db = getDb();

  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null;
  if (!taskRow) return null;

  const task = parseTaskRow(taskRow);

  // Try task_repos junction table first
  const repoRows = db.query(
    `SELECT r.* FROM repos r
     JOIN task_repos tr ON tr.repo_id = r.id
     WHERE tr.task_id = ? AND tr.role = 'target'
     ORDER BY r.name`
  ).all(taskId) as Array<Record<string, unknown>>;

  if (repoRows.length > 0) {
    return { task, repos: repoRows.map(parseRepoRow) };
  }

  // Fallback: legacy single-repo via tasks.repo_id
  if (taskRow.repo_id) {
    const repoRow = db.query("SELECT * FROM repos WHERE id = ?").get(taskRow.repo_id as number) as Record<string, unknown> | null;
    if (repoRow) {
      return { task, repos: [parseRepoRow(repoRow)] };
    }
  }

  return null;
}

export async function runTask(taskId: string): Promise<void> {
  const loaded = loadTaskAndRepos(taskId);
  if (!loaded) {
    logger.error("Task or repo not found", { taskId });
    updateTaskStatus(taskId, "failed");
    return;
  }

  let { task, repos } = loaded;

  // Set up branch name first so we can announce it
  const branchName = generateBranchName(task.id, task.title);
  updateTaskBranch(task.id, branchName);

  // Create messaging channel for this task
  const manager = getMessagingManager();
  if (manager) {
    try {
      await manager.createTaskChannel(task, branchName);
    } catch (err) {
      logger.warn("Failed to create messaging channel", { taskId, error: String(err) });
    }
  }

  // === PRE-PLAN (scope repos) ===
  // If multiple repos are assigned, run pre-plan to determine which ones actually need changes
  if (repos.length > 1) {
    updateTaskStatus(task.id, "scoping");
    logger.info("Running pre-plan to scope repos", { taskId, repoCount: repos.length });

    const { executePrePlan } = await import("./nodes/agentic/pre-plan");
    const prePlanResult = await executePrePlan(task);

    if (prePlanResult.error) {
      if (isTaskCancelled(task.id)) return;
      logger.error("Pre-plan failed", { taskId, error: prePlanResult.error });
      updateTaskStatus(task.id, "failed");
      return;
    }

    // Narrow repos to the ones pre-plan identified
    const targetNames = new Set(prePlanResult.repoNames);
    const narrowed = repos.filter((r) => targetNames.has(r.name));

    if (narrowed.length === 0) {
      logger.error("Pre-plan identified no valid repos", { taskId, suggested: prePlanResult.repoNames });
      updateTaskStatus(task.id, "failed");
      return;
    }

    logger.info("Pre-plan scoped repos", { taskId, repos: narrowed.map((r) => r.name) });

    // Notify channel of scoping result
    if (manager) {
      const repoList = narrowed.map((r) => r.name).join(", ");
      manager.notifyAgentOutput(task.id, `Repos to modify: ${repoList}`).catch(() => {});
    }

    // Update task_repos to reflect the narrowed scope
    const db = getDb();
    db.run("DELETE FROM task_repos WHERE task_id = ?", [task.id]);
    for (const r of narrowed) {
      db.run("INSERT INTO task_repos (task_id, repo_id, role) VALUES (?, ?, 'target')", [task.id, r.id]);
    }
    // Update legacy repo_id to first narrowed repo
    db.run("UPDATE tasks SET repo_id = ? WHERE id = ?", [narrowed[0].id, task.id]);

    repos = narrowed;
  }

  // === CLONE ALL REPOS ===
  await ensureTaskDir(task.id);
  const workDirs = new Map<string, string>(); // repoName -> workDir

  for (const repo of repos) {
    try {
      const wd = await createTaskClone(repo.path, task.id, repo.name, branchName);
      workDirs.set(repo.name, wd);
    } catch (err) {
      logger.error("Failed to clone repo for task", { repo: repo.name, error: String(err) });
      updateTaskStatus(task.id, "failed");
      return;
    }
  }

  // Use first repo's workDir for plan-phase tools (plan agent can read all repos via sibling dirs)
  const primaryRepo = repos[0];
  const primaryWorkDir = workDirs.get(primaryRepo.name) ?? "";

  // Generate MCP config for agent nodes (using primary repo)
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(task.id, primaryWorkDir, primaryRepo.name);
  } catch (err) {
    logger.warn("Failed to generate MCP config, agents will use direct tools", { error: String(err) });
  }

  let state = createInitialState();
  state.history.push({
    node: "index",
    entered_at: new Date().toISOString(),
    exited_at: null,
    result: null,
  });

  // === INDEX ALL REPOS ===
  updateTaskStatus(task.id, "indexing", state);
  logger.info("Starting index phase", { taskId: task.id, repoCount: repos.length });

  for (const repo of repos) {
    try {
      const indexResult = await indexRepo(repo);
      logger.info("Finished indexing", { repo: repo.name, chunks: indexResult.chunks });
      if (manager) {
        manager.notifyAgentOutput(task.id, `Finished indexing ${repo.name}: ${indexResult.chunks} chunks`).catch(() => {});
      }
    } catch (err) {
      logger.warn("Repo reindex failed, continuing", { repo: repo.name, error: String(err) });
    }
  }
  state = advanceState(state, "done");

  if (isTaskCancelled(task.id)) return;

  // === PLAN -> SCRUTINIZE -> PLAN AGAIN -> SCRUTINIZE -> FINALIZE ===
  const onThinking = makeThinkingForwarder(task.id, manager);
  const { executeScrutinize, executePlanAgain, executeFinalizePlan } = await import("./nodes/agentic/scrutinize");
  const { parseMultiRepoPlan } = await import("./plan-parser");
  const { buildPlanPrompt } = await import("./context-builder");

  // --- Plan (round 1) ---
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting plan phase", { taskId: task.id });

  // Unified plan prompt works for single or multi-repo
  const planPrompt = await buildPlanPrompt(task, repos);

  const planResult = await executePlan(
    task, primaryRepo, primaryWorkDir, mcpConfigPath, onThinking, planPrompt
  );

  if (planResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Planning failed", { taskId: task.id, error: planResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // --- Scrutinize/plan-again/finalize loop ---
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "scrutinizing", state);
  logger.info("Scrutinizing plan (round 1)", { taskId: task.id });

  const scrutiny1 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planResult.plan, mcpConfigPath, onThinking);

  if (scrutiny1.error) {
    if (isTaskCancelled(task.id)) return;
    logger.warn("Scrutiny failed, proceeding with original plan", { taskId: task.id });
    state = advanceState(state, "error");
  } else {
    if (isTaskCancelled(task.id)) return;

    state = advanceState(state, "done");
    updateTaskStatus(task.id, "replanning", state);
    logger.info("Revising plan based on scrutiny", { taskId: task.id });

    const planAgainResult = await executePlanAgain(
      task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, mcpConfigPath, onThinking
    );

    if (planAgainResult.error) {
      if (isTaskCancelled(task.id)) return;
      logger.warn("Plan-again failed, using original plan", { taskId: task.id });
      state = advanceState(state, "error");
    } else {
      if (isTaskCancelled(task.id)) return;

      state = advanceState(state, "done");
      updateTaskStatus(task.id, "scrutinizing", state);
      logger.info("Scrutinizing plan (round 2)", { taskId: task.id });

      const scrutiny2 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planAgainResult.plan, mcpConfigPath, onThinking);

      if (scrutiny2.error) {
        if (isTaskCancelled(task.id)) return;
        logger.warn("Final scrutiny failed, proceeding with revised plan", { taskId: task.id });
        state = advanceState(state, "error");
      } else {
        if (isTaskCancelled(task.id)) return;

        state = advanceState(state, "done");
        updateTaskStatus(task.id, "finalizing_plan", state);
        logger.info("Finalizing plan", { taskId: task.id });

        const finalPlan = await executeFinalizePlan(
          task, primaryRepo, primaryWorkDir, planAgainResult.plan, scrutiny2.output, mcpConfigPath, onThinking
        );

        if (!finalPlan.error && finalPlan.plan.length > 200) {
          planResult.plan = finalPlan.plan;
        } else {
          logger.warn("Finalize output too short or failed, using revised plan", { taskId: task.id, len: finalPlan.plan?.length });
          planResult.plan = planAgainResult.plan;
        }
        state = advanceState(state, "done");
      }
    }
  }

  // Sanity check: if the best plan is too short, fall back up the chain
  if (planResult.plan.length < 200) {
    logger.warn("Plan output suspiciously short, task may produce poor results", { taskId: task.id, len: planResult.plan.length });
  }

  if (isTaskCancelled(task.id)) return;

  // === IMPLEMENT (once, across all repos) ===
  updateTaskStatus(task.id, "implementing", state);
  logger.info("Starting implement phase", { taskId: task.id, repoCount: repos.length });

  if (manager && repos.length > 1) {
    manager.notifyAgentOutput(task.id, `Implementing across ${repos.length} repos: ${repos.map((r) => r.name).join(", ")}`).catch(() => {});
  }

  // For multi-repo, run from task dir so agent sees all repos as subdirs
  // For single-repo, run from the repo's workDir directly
  const implWorkDir = repos.length > 1 ? taskDir(task.id) : workDirs.get(repos[0].name)!;

  const implResult = await executeImplement(
    task, repos, implWorkDir, planResult.plan, mcpConfigPath, onThinking
  );

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === PER-REPO: CI -> LINT ===
  state = advanceState(state, "done");

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    logger.info("Running CI/lint for repo", { taskId: task.id, repo: repo.name });

    // Set up Docker container per repo if applicable
    let containerName: string | null = null;
    try {
      containerName = await setupTaskContainer(repo, workDir, task.id);
    } catch {}

    let repoMcpConfigPath: string | undefined;
    try {
      repoMcpConfigPath = await generateMcpConfig(task.id, workDir, repo.name);
    } catch {}

    // --- CI (test/build with fix loop) ---
    if (repo.test_cmd || repo.build_cmd) {
      updateTaskStatus(task.id, "ci_running", state);

      for (let round = 0; round < MAX_CI_ROUNDS; round++) {
        logger.info("Running CI", { taskId: task.id, repo: repo.name, round });

        const ciResult = await runCi(repo, workDir, containerName ?? undefined, (accumulated) => {
          saveNodeOutput(task.id, "ci", accumulated, false);
        });
        saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

        if (ciResult.success) break;

        if (containerName) discoverSecrets(repo.id, ciResult.output);
        if (round >= MAX_CI_ROUNDS - 1) break;
        if (isTaskCancelled(task.id)) return;

        state = advanceState(state, "fail");
        updateTaskStatus(task.id, "ci_fixing", state);

        const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, repoMcpConfigPath);
        if (fixResult.error) {
          if (isTaskCancelled(task.id)) return;
          break;
        }

        state = advanceState(state, "done");
        state.ci_rounds++;
        updateTaskStatus(task.id, "ci_running", state);
      }
    }

    if (isTaskCancelled(task.id)) return;

    // --- Lint (with fix loop) ---
    if (repo.lint_cmd) {
      updateTaskStatus(task.id, "linting", state);

      for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
        logger.info("Running lint", { taskId: task.id, repo: repo.name, round });

        const lintResult = await executeLint(repo, workDir, containerName ?? undefined, (accumulated) => {
          saveNodeOutput(task.id, "lint", accumulated, false);
        });
        saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

        if (lintResult.success) break;

        if (containerName) discoverSecrets(repo.id, lintResult.output);
        if (round >= MAX_LINT_ROUNDS) break;
        if (isTaskCancelled(task.id)) return;

        state = advanceState(state, "errors");
        updateTaskStatus(task.id, "fix_linting", state);

        const fixResult = await executeFixLint(task, repo, workDir, lintResult.output, lintResult.command, repoMcpConfigPath);
        if (fixResult.error) {
          if (isTaskCancelled(task.id)) return;
          break;
        }

        state = advanceState(state, "done");
        state.lint_rounds++;
        updateTaskStatus(task.id, "linting", state);
      }
    }

    // Tear down Docker container
    if (containerName) {
      try { await teardownTaskContainer(task.id); } catch {}
    }
  }

  if (isTaskCancelled(task.id)) return;

  // === REVIEW: COMMIT + PUSH + CREATE PR PER REPO ===
  logger.info("Task ready for review", { taskId: task.id });

  const notifyError = (msg: string) => {
    logger.error(msg, { taskId: task.id });
    if (manager) manager.notifyAgentOutput(task.id, `[error] ${msg}`).catch(() => {});
  };

  const prUrls: string[] = [];

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    // Commit
    try {
      await $`git -C ${workDir} add -A`.quiet();
      const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
      if (hasChanges.exitCode !== 0) {
        await $`git -C ${workDir} commit -m ${`hoto: ${task.title}`}`.quiet();
        logger.info("Committed changes", { taskId: task.id, repo: repo.name });
      } else {
        logger.info("No changes to commit", { taskId: task.id, repo: repo.name });
        continue; // Skip push/PR for repos with no changes
      }
    } catch (err) {
      notifyError(`Failed to commit changes for ${repo.name}: ${err}`);
      continue;
    }

    // Push + create PR
    if (isGiteaConfigured()) {
      try {
        await ensureRepoOnGitea(repo.path, repo.name);
        await pushBranchToGitea(workDir, repo.path, repo.name, branchName);

        const { getDefaultBranch } = await import("../workspace/git");
        const baseBranch = await getDefaultBranch(repo.path);

        const db = getDb();
        const lintRow = db.query("SELECT lint_passed FROM tasks WHERE id = ?").get(task.id) as { lint_passed: number | null } | null;
        const ciRow = db.query("SELECT ci_passed FROM tasks WHERE id = ?").get(task.id) as { ci_passed: number | null } | null;

        const planRow = db.query(
          "SELECT output FROM agent_runs WHERE task_id = ? AND node_name IN ('finalize-plan', 'plan') ORDER BY finished_at DESC LIMIT 1"
        ).get(task.id) as { output: string } | null;
        const planOutput = planRow?.output ?? "";

        let diffStat = "";
        try {
          const diffResult = await $`git -C ${workDir} diff --stat HEAD`.quiet().nothrow();
          diffStat = diffResult.stdout.toString().trim();
        } catch (err) {
          logger.warn("Failed to get diff stat for PR body", { taskId: task.id, error: String(err) });
        }

        const prMetadata = generatePrMetadata(
          task,
          planOutput,
          diffStat,
          lintRow?.lint_passed != null ? !!lintRow.lint_passed : null,
          ciRow?.ci_passed != null ? !!ciRow.ci_passed : null
        );

        const pr = await createPullRequest(
          repo.name, branchName, baseBranch,
          prMetadata.title, prMetadata.body
        );

        const prUrl = rewriteGiteaUrl(pr.html_url);
        prUrls.push(prUrl);

        // Store in task_prs
        db.run(
          "INSERT OR REPLACE INTO task_prs (task_id, repo_id, pr_number, pr_url) VALUES (?, ?, ?, ?)",
          [task.id, repo.id, pr.number, prUrl]
        );

        // Legacy compat: store first PR on tasks table
        if (prUrls.length === 1) {
          db.run(
            "UPDATE tasks SET gitea_pr_number = ?, gitea_pr_url = ? WHERE id = ?",
            [pr.number, prUrl, task.id]
          );
        }

        logger.info("Created Gitea PR", { taskId: task.id, repo: repo.name, prNumber: pr.number, url: prUrl });

        await seedCursors(task.id, repo.name, pr.number);
        startReviewPoller(task.id, repo.name, repo.path, branchName, pr.number);
      } catch (err) {
        notifyError(`Gitea push/PR failed for ${repo.name}: ${err}`);
      }
    } else {
      notifyError(`Gitea not configured. Changes for ${repo.name} not pushed.`);
    }
  }

  // 3. Notify with all PR URLs
  if (prUrls.length > 0 && manager) {
    const prList = prUrls.map((url) => `  ${url}`).join("\n");
    manager.notifyAgentOutput(task.id, `Pull requests created:\n${prList}`).catch(() => {});
  }

  // 4. Now set review status -- notifyTaskStatusChange will read the PR URL from DB
  updateTaskStatus(task.id, "review", state);

  // 5. Also announce in main channel with PR link
  if (manager) {
    manager.notifyReviewReady(task).catch(() => {});
  }

  // Index chat history into knowledge base
  indexTaskChatHistory(task.id).catch((err) => {
    logger.warn("Failed to index chat history", { taskId: task.id, error: String(err) });
  });
}

export async function reviseTask(taskId: string, feedback: string): Promise<void> {
  const loaded = loadTaskAndRepos(taskId);
  if (!loaded) {
    logger.error("Task or repo not found for revision", { taskId });
    return;
  }

  const { task, repos } = loaded;
  const branchName = task.branch_name!;

  // Build workDir map from existing clones
  const workDirs = new Map<string, string>();
  for (const repo of repos) {
    workDirs.set(repo.name, worktreeDir(taskId, repo.name));
  }

  const primaryRepo = repos[0];
  const primaryWorkDir = workDirs.get(primaryRepo.name)!;

  // Restore MCP config
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(task.id, primaryWorkDir, primaryRepo.name);
  } catch (err) {
    logger.warn("Failed to generate MCP config for revision", { error: String(err) });
  }

  // Load current blueprint state
  const db = getDb();
  const taskRow = db.query("SELECT blueprint_state FROM tasks WHERE id = ?").get(taskId) as { blueprint_state: string | null } | null;
  if (!taskRow?.blueprint_state) {
    logger.error("No blueprint state found for revision", { taskId });
    updateTaskStatus(taskId, "failed");
    return;
  }

  let state: BlueprintState = JSON.parse(taskRow.blueprint_state);

  const manager = getMessagingManager();
  const notifyError = (msg: string) => {
    logger.error(msg, { taskId: task.id });
    if (manager) manager.notifyAgentOutput(task.id, `[error] ${msg}`).catch(() => {});
  };

  const onThinking = makeThinkingForwarder(task.id, manager);
  const { executeScrutinize, executePlanAgain, executeFinalizePlan } = await import("./nodes/agentic/scrutinize");
  const { parseMultiRepoPlan } = await import("./plan-parser");

  // Advance from review -> plan via "revise"
  state = advanceState(state, "revise");

  // === PLAN (revision) ===
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting revision plan phase", { taskId: task.id, repoCount: repos.length });

  const previousPlanRow = db.query(
    "SELECT output FROM agent_runs WHERE task_id = ? AND node_name IN ('plan', 'plan_again', 'finalize_plan') ORDER BY finished_at DESC LIMIT 1"
  ).get(task.id) as { output: string } | null;
  const previousPlan = previousPlanRow?.output ?? "(no previous plan found)";

  const { buildRevisionPlanPrompt } = await import("./context-builder");
  const revisionPlanPrompt = await buildRevisionPlanPrompt(task, primaryRepo, feedback, previousPlan);

  const planResult = await executePlan(task, primaryRepo, primaryWorkDir, mcpConfigPath, onThinking, revisionPlanPrompt);

  if (planResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Revision planning failed", { taskId: task.id, error: planResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // --- Scrutinize loop (same as runTask) ---
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "scrutinizing", state);

  const scrutiny1 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planResult.plan, mcpConfigPath, onThinking);

  if (!scrutiny1.error) {
    if (isTaskCancelled(task.id)) return;
    state = advanceState(state, "done");
    updateTaskStatus(task.id, "replanning", state);

    const planAgainResult = await executePlanAgain(
      task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, mcpConfigPath, onThinking
    );

    if (!planAgainResult.error) {
      if (isTaskCancelled(task.id)) return;
      state = advanceState(state, "done");
      updateTaskStatus(task.id, "scrutinizing", state);

      const scrutiny2 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planAgainResult.plan, mcpConfigPath, onThinking);

      if (!scrutiny2.error) {
        if (isTaskCancelled(task.id)) return;
        state = advanceState(state, "done");
        updateTaskStatus(task.id, "finalizing_plan", state);

        const finalPlan = await executeFinalizePlan(
          task, primaryRepo, primaryWorkDir, planAgainResult.plan, scrutiny2.output, mcpConfigPath, onThinking
        );

        planResult.plan = (!finalPlan.error && finalPlan.plan.length > 200) ? finalPlan.plan : planAgainResult.plan;
        state = advanceState(state, "done");
      } else {
        planResult.plan = planAgainResult.plan;
        state = advanceState(state, "error");
      }
    } else {
      state = advanceState(state, "error");
    }
  } else {
    state = advanceState(state, "error");
  }

  if (isTaskCancelled(task.id)) return;

  // === IMPLEMENT (once, across all repos) ===
  updateTaskStatus(task.id, "implementing", state);
  logger.info("Starting revision implement phase", { taskId: task.id, repoCount: repos.length });

  const implWorkDir = repos.length > 1 ? taskDir(task.id) : workDirs.get(repos[0].name)!;

  const implResult = await executeImplement(
    task, repos, implWorkDir, planResult.plan, mcpConfigPath, onThinking
  );

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Revision implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === PER-REPO: CI -> LINT ===
  state = advanceState(state, "done");

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    let containerName: string | null = null;
    try { containerName = await setupTaskContainer(repo, workDir, task.id); } catch {}

    let repoMcpConfigPath: string | undefined;
    try { repoMcpConfigPath = await generateMcpConfig(task.id, workDir, repo.name); } catch {}

    // --- CI ---
    if (repo.test_cmd || repo.build_cmd) {
      updateTaskStatus(task.id, "ci_running", state);

      for (let round = 0; round < MAX_CI_ROUNDS; round++) {
        const ciResult = await runCi(repo, workDir, containerName ?? undefined, (accumulated) => {
          saveNodeOutput(task.id, "ci", accumulated, false);
        });
        saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

        if (ciResult.success) break;
        if (containerName) discoverSecrets(repo.id, ciResult.output);
        if (round >= MAX_CI_ROUNDS - 1) break;
        if (isTaskCancelled(task.id)) return;

        state = advanceState(state, "fail");
        updateTaskStatus(task.id, "ci_fixing", state);

        const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, repoMcpConfigPath);
        if (fixResult.error) { if (isTaskCancelled(task.id)) return; break; }

        state = advanceState(state, "done");
        state.ci_rounds++;
        updateTaskStatus(task.id, "ci_running", state);
      }
    }

    if (isTaskCancelled(task.id)) return;

    // --- Lint ---
    if (repo.lint_cmd) {
      updateTaskStatus(task.id, "linting", state);

      for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
        const lintResult = await executeLint(repo, workDir, containerName ?? undefined, (accumulated) => {
          saveNodeOutput(task.id, "lint", accumulated, false);
        });
        saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

        if (lintResult.success) break;
        if (containerName) discoverSecrets(repo.id, lintResult.output);
        if (round >= MAX_LINT_ROUNDS) break;
        if (isTaskCancelled(task.id)) return;

        state = advanceState(state, "errors");
        updateTaskStatus(task.id, "fix_linting", state);

        const fixResult = await executeFixLint(task, repo, workDir, lintResult.output, lintResult.command, repoMcpConfigPath);
        if (fixResult.error) { if (isTaskCancelled(task.id)) return; break; }

        state = advanceState(state, "done");
        state.lint_rounds++;
        updateTaskStatus(task.id, "linting", state);
      }
    }

    if (containerName) {
      try { await teardownTaskContainer(task.id); } catch {}
    }
  }

  if (isTaskCancelled(task.id)) return;

  // === REVIEW: COMMIT + PUSH PER REPO ===
  logger.info("Revision ready for review", { taskId: task.id });

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    // Commit
    try {
      await $`git -C ${workDir} add -A`.quiet();
      const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
      if (hasChanges.exitCode !== 0) {
        await $`git -C ${workDir} commit -m ${`hoto: revision for ${task.title}`}`.quiet();
        logger.info("Committed revision changes", { taskId: task.id, repo: repo.name });
      } else {
        continue;
      }
    } catch (err) {
      notifyError(`Failed to commit revision for ${repo.name}: ${err}`);
      continue;
    }

    // Push (force, since we're updating existing PRs)
    if (isGiteaConfigured()) {
      try {
        await pushBranchToGitea(workDir, repo.path, repo.name, branchName, true);
        logger.info("Pushed revision", { taskId: task.id, repo: repo.name });
      } catch (err) {
        notifyError(`Gitea push after revision failed for ${repo.name}: ${err}`);
      }

      const db = getDb();
      const prRow = db.query(
        "SELECT pr_number FROM task_prs WHERE task_id = ? AND repo_id = ?"
      ).get(task.id, repo.id) as { pr_number: number } | null;
      const prNumber = prRow?.pr_number ?? (
        db.query("SELECT gitea_pr_number FROM tasks WHERE id = ?").get(task.id) as { gitea_pr_number: number | null } | null
      )?.gitea_pr_number ?? null;

      if (prNumber) {
        try {
          const planRow = db.query(
            "SELECT output FROM agent_runs WHERE task_id = ? AND node_name IN ('finalize-plan', 'plan') ORDER BY finished_at DESC LIMIT 1"
          ).get(task.id) as { output: string } | null;
          const planOutput = planRow?.output ?? "";

          let diffStat = "";
          try {
            const diffResult = await $`git -C ${workDir} diff --stat HEAD`.quiet().nothrow();
            diffStat = diffResult.stdout.toString().trim();
          } catch (diffErr) {
            logger.warn("Failed to get diff stat for PR update", { taskId: task.id, error: String(diffErr) });
          }

          const prMetadata = generatePrMetadata(task, planOutput, diffStat, null, null);
          await updatePullRequest(repo.name, prNumber, prMetadata.title, prMetadata.body);
          logger.info("Updated Gitea PR title and body after revision", { taskId: task.id, repo: repo.name, prNumber });
        } catch (err) {
          notifyError(`Failed to update PR title/body after revision for ${repo.name}: ${err}`);
        }
      }
    }
  }

  // Set review status
  updateTaskStatus(task.id, "review", state);

  // Announce in main channel
  if (manager) {
    manager.notifyReviewReady(task).catch(() => {});
  }

  // Index chat history
  indexTaskChatHistory(task.id).catch((err) => {
    logger.warn("Failed to index chat history", { taskId: task.id, error: String(err) });
  });
}

async function runCi(
  repo: Repo,
  workDir: string,
  containerName?: string,
  onChunk?: (accumulated: string) => void
): Promise<{ success: boolean; output: string }> {
  const commands: string[] = [];
  if (repo.build_cmd) commands.push(repo.build_cmd);
  if (repo.test_cmd) commands.push(repo.test_cmd);

  let allOutput = "";

  const emit = (text: string) => {
    allOutput += text;
    onChunk?.(allOutput);
  };

  const decoder = new TextDecoder();

  for (const cmd of commands) {
    logger.info("Running CI command", { cmd, containerName });
    emit(`\n$ ${cmd}\n`);

    try {
      const argv = containerName
        ? ["docker", "exec", "-w", "/workspace", containerName, "sh", "-c", cmd]
        : ["sh", "-c", cmd];

      const proc = Bun.spawn(argv, {
        cwd: containerName ? undefined : workDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const readStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          emit(decoder.decode(value, { stream: true }));
        }
      };

      await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
      await proc.exited;

      if (proc.exitCode !== 0) {
        return { success: false, output: allOutput };
      }
    } catch (err) {
      emit(`Error: ${err}`);
      return { success: false, output: allOutput };
    }
  }

  return { success: true, output: allOutput };
}
