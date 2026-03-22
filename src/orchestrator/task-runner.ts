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
import { createTaskClone, generateBranchName, removeTaskClone } from "../workspace/git";
import { ensureTaskDir, taskDir, worktreeDir } from "../workspace/manager";
import { killTaskSubprocesses } from "./subprocess-registry";
import { indexRepo } from "../knowledge/indexer";
import { generateMcpConfig } from "./subprocess";
import { setupTaskContainer, teardownTaskContainer } from "../workspace/docker-exec";
import { discoverSecrets } from "../workspace/secret-discovery";
import { renderTemplate } from "../prompts/loader";
import { getMessagingManager } from "../messaging/manager";
import { config } from "../shared/config";
import { indexTaskChatHistory } from "../messaging/indexer";
import { isGiteaConfigured, createPullRequest, commentOnPullRequest } from "../gitea/client";
import { ensureRepoOnGitea, pushBranchToGitea } from "../gitea/repo-sync";
import { startReviewPoller } from "../gitea/review-poller";
import { $ } from "bun";

const MAX_LINT_ROUNDS = 1;
const MAX_CI_ROUNDS = 2;
const INPUT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INPUT_POLL_INTERVAL_MS = 2000;

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

export async function runTask(taskId: string): Promise<void> {
  const loaded = loadTaskAndRepo(taskId);
  if (!loaded) {
    logger.error("Task or repo not found", { taskId });
    updateTaskStatus(taskId, "failed");
    return;
  }

  const { task, repo } = loaded;

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

  let workDir: string;
  try {
    await ensureTaskDir(task.id);
    workDir = await createTaskClone(repo.path, task.id, repo.name, branchName);
  } catch (err) {
    logger.error("Failed to clone repo for task", { error: String(err) });
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

      const lintResult = await executeLint(repo, workDir, containerName ?? undefined, (accumulated) => {
        saveNodeOutput(task.id, "lint", accumulated, false);
      });
      saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

      if (lintResult.success) {
        _lintPassed = true;
        break;
      }

      // Scan lint failure output for missing secrets
      if (containerName) {
        discoverSecrets(repo.id, lintResult.output);
      }

      if (round >= MAX_LINT_ROUNDS) {
        logger.warn("Lint fix limit reached, proceeding anyway", { taskId: task.id });
        break;
      }

      if (isTaskCancelled(task.id)) return;

      // Fix lint errors
      state = advanceState(state, "errors");
      updateTaskStatus(task.id, "fix_linting", state);
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
      updateTaskStatus(task.id, "linting", state);
    }
  }

  if (isTaskCancelled(task.id)) return;

  // === CI (test/build with fix loop) ===
  if (repo.test_cmd || repo.build_cmd) {
    state = advanceState(state, "clean");
    updateTaskStatus(task.id, "ci_running", state);

    for (let round = 0; round < MAX_CI_ROUNDS; round++) {
      logger.info("Running CI", { taskId: task.id, round });

      const ciResult = await runCi(repo, workDir, containerName ?? undefined, (accumulated) => {
        saveNodeOutput(task.id, "ci", accumulated, false);
      });
      saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

      if (ciResult.success) {
        state = advanceState(state, "pass");
        break;
      }

      // Scan CI failure output for missing secrets
      if (containerName) {
        discoverSecrets(repo.id, ciResult.output);
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
    state = advanceState(state, "clean"); // lint -> ci
    state = advanceState(state, "pass");  // ci -> review
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
  logger.info("Task ready for review", { taskId: task.id });

  const notifyError = (msg: string) => {
    logger.error(msg, { taskId: task.id });
    if (manager) manager.notifyAgentOutput(task.id, `[error] ${msg}`).catch(() => {});
  };

  // 1. Commit all changes
  try {
    await $`git -C ${workDir} add -A`.quiet();
    const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
    if (hasChanges.exitCode !== 0) {
      await $`git -C ${workDir} commit -m ${"hoto: " + task.title}`.quiet();
      logger.info("Committed implementation changes", { taskId: task.id });
    }
  } catch (err) {
    notifyError(`Failed to commit changes: ${err}`);
  }

  // 2. Push to Gitea and create PR (before setting review status, so the URL is available)
  if (isGiteaConfigured()) {
    try {
      await ensureRepoOnGitea(repo.path, repo.name);
      await pushBranchToGitea(workDir, repo.path, repo.name, branchName);

      const { getDefaultBranch } = await import("../workspace/git");
      const baseBranch = await getDefaultBranch(repo.path);

      const db = getDb();
      const lintRow = db.query("SELECT lint_passed FROM tasks WHERE id = ?").get(task.id) as { lint_passed: number | null } | null;
      const ciRow = db.query("SELECT ci_passed FROM tasks WHERE id = ?").get(task.id) as { ci_passed: number | null } | null;

      const prBody = [
        `Task ID: \`${task.id}\``,
        "",
        task.description,
        "",
        "---",
        `Lint: ${lintRow?.lint_passed ? "passed" : "failed/skipped"}`,
        `CI: ${ciRow?.ci_passed ? "passed" : "failed/skipped"}`,
      ].join("\n");

      const pr = await createPullRequest(
        repo.name,
        branchName,
        baseBranch,
        `hoto: ${task.title}`,
        prBody
      );

      db.run(
        "UPDATE tasks SET gitea_pr_number = ?, gitea_pr_url = ? WHERE id = ?",
        [pr.number, pr.html_url, task.id]
      );

      logger.info("Created Gitea PR", { taskId: task.id, prNumber: pr.number, url: pr.html_url });

      // Start polling for review events
      startReviewPoller(task.id, repo.name, repo.path, branchName, pr.number);
    } catch (err) {
      notifyError(`Gitea push/PR failed: ${err}`);
    }
  } else {
    notifyError(`Gitea not configured (GITEA_URL=${config.giteaUrl ?? "unset"}, bot token=${isGiteaConfigured() ? "ok" : "missing"}). Branch not pushed.`);
  }

  // 3. Now set review status -- notifyTaskStatusChange will read the PR URL from DB
  updateTaskStatus(task.id, "review", state);

  // 4. Also announce in main channel with PR link
  if (manager) {
    manager.notifyReviewReady(task).catch(() => {});
  }

  // Index chat history into knowledge base
  indexTaskChatHistory(task.id).catch((err) => {
    logger.warn("Failed to index chat history", { taskId: task.id, error: String(err) });
  });
}

export async function reviseTask(taskId: string, feedback: string): Promise<void> {
  const loaded = loadTaskAndRepo(taskId);
  if (!loaded) {
    logger.error("Task or repo not found for revision", { taskId });
    return;
  }

  const { task, repo } = loaded;
  const workDir = worktreeDir(taskId, repo.name);

  // Restore MCP config
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(task.id, workDir, repo.name);
  } catch (err) {
    logger.warn("Failed to generate MCP config for revision", { error: String(err) });
  }

  // Restore Docker container
  let containerName: string | null = null;
  try {
    containerName = await setupTaskContainer(repo, workDir, task.id);
  } catch (err) {
    logger.warn("Docker setup failed for revision, running locally", { error: String(err) });
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

  // Advance from review -> plan via "revise"
  state = advanceState(state, "revise");

  // === PLAN (revision) ===
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting revision plan phase", { taskId: task.id });

  // Build revision context: feedback + chat history
  const { getChatContext } = await import("./context-builder");
  const chatContext = await getChatContext(task.id);
  const revisionContext = await renderTemplate("revise", {
    feedback,
    chatContext: chatContext || undefined,
  });

  // Append revision context to the task description for planning
  const revisedTask = {
    ...task,
    description: `${task.description}\n\n---\nRevision feedback:\n${revisionContext}`,
  };

  const planResult = await executePlan(revisedTask, repo, workDir, mcpConfigPath);

  if (planResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Revision planning failed", { taskId: task.id, error: planResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === IMPLEMENT (revision) ===
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "implementing", state);
  logger.info("Starting revision implement phase", { taskId: task.id });

  const implResult = await executeImplement(task, repo, workDir, planResult.plan, mcpConfigPath);

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Revision implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "review", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === LINT (with fix loop) ===
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "linting", state);

  if (repo.lint_cmd) {
    for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
      const lintResult = await executeLint(repo, workDir, containerName ?? undefined, (accumulated) => {
        saveNodeOutput(task.id, "lint", accumulated, false);
      });
      saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

      if (lintResult.success) break;

      if (containerName) {
        discoverSecrets(repo.id, lintResult.output);
      }

      if (round >= MAX_LINT_ROUNDS) break;
      if (isTaskCancelled(task.id)) return;

      state = advanceState(state, "errors");
      updateTaskStatus(task.id, "fix_linting", state);

      const fixResult = await executeFixLint(
        task, repo, workDir,
        lintResult.output, lintResult.command, mcpConfigPath
      );

      if (fixResult.error) {
        if (isTaskCancelled(task.id)) return;
        break;
      }

      state = advanceState(state, "done");
      state.lint_rounds++;
      updateTaskStatus(task.id, "linting", state);
    }
  }

  if (isTaskCancelled(task.id)) return;

  // === CI ===
  if (repo.test_cmd || repo.build_cmd) {
    state = advanceState(state, "clean");
    updateTaskStatus(task.id, "ci_running", state);

    for (let round = 0; round < MAX_CI_ROUNDS; round++) {
      const ciResult = await runCi(repo, workDir, containerName ?? undefined, (accumulated) => {
        saveNodeOutput(task.id, "ci", accumulated, false);
      });
      saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

      if (ciResult.success) {
        state = advanceState(state, "pass");
        break;
      }

      if (containerName) {
        discoverSecrets(repo.id, ciResult.output);
      }

      if (round >= MAX_CI_ROUNDS - 1) {
        state = advanceState(state, "pass");
        break;
      }

      if (isTaskCancelled(task.id)) return;

      state = advanceState(state, "fail");
      updateTaskStatus(task.id, "ci_fixing", state);

      const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, mcpConfigPath);

      if (fixResult.error) {
        if (isTaskCancelled(task.id)) return;
        state = advanceState(state, "error");
        break;
      }

      state = advanceState(state, "done");
      state.ci_rounds++;
      updateTaskStatus(task.id, "ci_running", state);
    }
  } else {
    state = advanceState(state, "clean"); // lint -> ci
    state = advanceState(state, "pass");  // ci -> review
  }

  // Tear down Docker container
  if (containerName) {
    try {
      await teardownTaskContainer(task.id);
    } catch (err) {
      logger.warn("Docker teardown failed", { taskId: task.id, error: String(err) });
    }
  }

  // === REVIEW ===
  logger.info("Revision ready for review", { taskId: task.id });

  // 1. Commit revision changes
  try {
    await $`git -C ${workDir} add -A`.quiet();
    const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
    if (hasChanges.exitCode !== 0) {
      await $`git -C ${workDir} commit -m ${"hoto: revision for " + task.title}`.quiet();
      logger.info("Committed revision changes", { taskId: task.id });
    }
  } catch (err) {
    notifyError(`Failed to commit revision changes: ${err}`);
  }

  // 2. Push to Gitea (before setting review status, so URL is available)
  if (isGiteaConfigured()) {
    const prRow = db.query("SELECT gitea_pr_number FROM tasks WHERE id = ?").get(task.id) as { gitea_pr_number: number | null } | null;
    if (prRow?.gitea_pr_number) {
      try {
        const branchName = task.branch_name!;
        await pushBranchToGitea(workDir, repo.path, repo.name, branchName, true);
      } catch (err) {
        notifyError(`Gitea push after revision failed: ${err}`);
      }
    } else {
      notifyError("No existing Gitea PR found for revision push.");
    }
  } else {
    notifyError(`Gitea not configured (GITEA_URL=${config.giteaUrl ?? "unset"}). Revision not pushed.`);
  }

  // 3. Set review status
  updateTaskStatus(task.id, "review", state);

  // 4. Announce in main channel
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
