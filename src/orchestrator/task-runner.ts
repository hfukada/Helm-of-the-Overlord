import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import type { Task, Repo, BlueprintState, TaskStatus } from "../shared/types";
import { createInitialState, advanceState } from "./blueprint";
import { executePlan } from "./nodes/agentic/plan";
import { executeImplement } from "./nodes/agentic/implement";
import { executeFixLint } from "./nodes/agentic/fix-lint";
import { executeFixCi } from "./nodes/agentic/fix-ci";
import { executeLint } from "./nodes/deterministic/lint";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTaskClone, generateBranchName } from "../workspace/git";
import { ensureTaskDir, taskDir, worktreeDir } from "../workspace/manager";
import { killTaskSubprocesses } from "./subprocess-registry";
import { indexRepo } from "../knowledge/indexer";
import { generateMcpConfig } from "./subprocess";
import { setupTaskContainer, teardownTaskContainer, isSandboxContainer, startSandboxContainer } from "../workspace/docker-exec";
import type { SandboxOptions } from "./nodes/agentic/types";
import { discoverSecrets } from "../workspace/secret-discovery";
import { getMessagingManager } from "../messaging/manager";
import { indexTaskChatHistory } from "../messaging/indexer";
import { isGiteaConfigured, createPullRequest, updatePullRequest, rewriteGiteaUrl } from "../gitea/client";
import { ensureRepoOnGitea, pushBranchToGitea } from "../gitea/repo-sync";
import { startReviewPoller, seedCursors } from "../gitea/review-poller";
import { $ } from "bun";

const MAX_LINT_ROUNDS = 2;
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

/**
 * Check if a line is agent preamble/filler rather than actual plan content.
 * Instead of pattern-matching filler, we look for lines that ARE plan content:
 * - Starts with a markdown heading that isn't "Plan" or "Summary" (those are structural)
 * - Is inside a known section like "### Summary"
 * Anything before the first structured section heading is considered filler.
 */
function isFiller(line: string): boolean {
  const trimmed = line.replace(/^#+\s*/, "").trim();
  return trimmed.length === 0;
}

function generatePrMetadata(
  task: Task,
  planOutput: string,
  diffStat: string,
  lintPassed: boolean | null,
  ciPassed: boolean | null,
  ciOutput: string | null,
  lintOutput: string | null
): { title: string; body: string } {
  // Derive title from the Summary section content, or fall back to task.title.
  // Never use raw agent preamble -- only use structured content.
  let title = task.title;
  const summarySection = planOutput.match(/^#{1,3}\s*Summary\n+([\s\S]*?)(?=\n#{1,3}\s|\n---|\Z)/m);
  if (summarySection) {
    // Use the first non-empty line of the summary section
    const summaryLines = summarySection[1].trim().split("\n");
    for (const sl of summaryLines) {
      const stripped = sl.replace(/^[-*]\s*/, "").trim();
      if (stripped.length > 0) {
        title = stripped.length > 72 ? stripped.slice(0, 72) : stripped;
        break;
      }
    }
  }

  // Find the "## Execution Plan" or "### Execution Plan" section as the plan body.
  // Fall back to full planOutput if no such section exists.
  let planBody = planOutput;
  const execIdx = planOutput.search(/^#{1,3}\s*Execution Plan/m);
  if (execIdx >= 0) {
    planBody = planOutput.slice(execIdx);
  }

  // Truncate plan to ~3000 chars.
  const planTruncated = planBody.length > 3000
    ? `${planBody.slice(0, 3000)}\n...(truncated)`
    : planBody;

  // Determine lint/CI status -- distinguish "skipped" from "failed"
  const lintStatus = lintPassed === null
    ? "skipped"
    : lintPassed
      ? "passed"
      : (lintOutput?.includes("[SKIPPED]") ? "skipped (not configured)" : "failed");
  const ciStatus = ciPassed === null
    ? "skipped"
    : ciPassed
      ? "passed"
      : (ciOutput?.includes("[SKIPPED]") ? "skipped (not configured)" : "failed");

  const bodyParts: string[] = [];

  // Summary from the "### Summary" section if it exists, otherwise first non-filler paragraph
  const summaryMatch = planOutput.match(/^#{1,3}\s*Summary\n+([\s\S]*?)(?=\n#{1,3}\s|\n---|\Z)/m);
  if (summaryMatch) {
    const summaryText = summaryMatch[1].trim();
    const summary = summaryText.length > 500 ? `${summaryText.slice(0, 500)}...` : summaryText;
    bodyParts.push(summary);
    bodyParts.push("");
  } else {
    // Fall back: first non-filler paragraph
    const paragraphs = planOutput.split(/\n\n+/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed && !isFiller(trimmed)) {
        const summary = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
        bodyParts.push(summary);
        bodyParts.push("");
        break;
      }
    }
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
    docker_image: row.docker_image as string | null,
    ci_on_host: !!(row.ci_on_host as number),
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

  // Start sandbox container if configured
  let sandbox: SandboxOptions | undefined;
  if (config.sandboxClaude) {
    try {
      const sandboxName = await startSandboxContainer(task.id, taskDir(task.id));
      if (sandboxName) {
        const containerWorkDir = repos.length > 1
          ? "/workspace"
          : `/workspace/${primaryRepo.name}`;
        sandbox = { containerName: sandboxName, containerWorkDir };
        logger.info("Sandbox container started for task", { taskId: task.id, containerName: sandboxName });
      } else {
        logger.warn("Sandbox container failed to start, falling back to host execution", { taskId: task.id });
      }
    } catch (err) {
      logger.warn("Sandbox container setup failed, falling back to host execution", { taskId: task.id, error: String(err) });
    }
  }

  // Generate MCP config for agent nodes (using primary repo)
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(
      task.id, primaryWorkDir, primaryRepo.name,
      sandbox ? { sandboxed: true, containerWorkDir: sandbox.containerWorkDir } : undefined
    );
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

  const { buildPlanPrompt } = await import("./context-builder");

  // --- Plan (round 1) ---
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting plan phase", { taskId: task.id });

  // Unified plan prompt works for single or multi-repo
  const planPrompt = await buildPlanPrompt(task, repos);

  const planResult = await executePlan(
    task, primaryRepo, primaryWorkDir, mcpConfigPath, onThinking, planPrompt, sandbox
  );

  if (planResult.error || planResult.plan.length < 200) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Planning failed or produced insufficient output", {
      taskId: task.id,
      error: planResult.error,
      outputLen: planResult.plan.length,
    });
    if (manager) {
      manager.notifyAgentOutput(task.id, `[error] Plan output too short (${planResult.plan.length} chars). The planning agent may have run out of turns while exploring.`).catch(() => {});
    }
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "error", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // --- Scrutinize/plan-again/finalize loop ---
  state = advanceState(state, "done");
  updateTaskStatus(task.id, "scrutinizing", state);
  logger.info("Scrutinizing plan (round 1)", { taskId: task.id });

  const scrutiny1 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planResult.plan, mcpConfigPath, onThinking, sandbox);

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
      task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, mcpConfigPath, onThinking, sandbox
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

      const scrutiny2 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planAgainResult.plan, mcpConfigPath, onThinking, sandbox);

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
          task, primaryRepo, primaryWorkDir, planAgainResult.plan, scrutiny2.output, mcpConfigPath, onThinking, sandbox
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
    task, repos, implWorkDir, planResult.plan, mcpConfigPath, onThinking, sandbox
  );

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "error", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === PER-REPO: CI -> LINT ===
  state = advanceState(state, "done");

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    logger.info("Running CI/lint for repo", { taskId: task.id, repo: repo.name });

    // Use sandbox container if active, otherwise set up per-repo container
    let containerName: string | null = sandbox?.containerName ?? null;
    let containerWorkDir = sandbox ? `/workspace/${repo.name}` : "/workspace";

    if (!containerName) {
      try {
        containerName = await setupTaskContainer(repo, workDir, task.id, taskDir(task.id));
      } catch (err) {
        logger.error({ err, taskId: task.id }, "failed to set up task container");
        containerName = null;
      }
      containerWorkDir = (containerName && isSandboxContainer(containerName))
        ? `/workspace/${repo.name}`
        : "/workspace";
    }

    let repoMcpConfigPath: string | undefined;
    try {
      repoMcpConfigPath = await generateMcpConfig(
        task.id, workDir, repo.name,
        sandbox ? { sandboxed: true, containerWorkDir } : undefined
      );
    } catch {}

    // --- CI (test/build with fix loop) ---
    if (repo.test_cmd || repo.build_cmd) {
      if (!repo.test_cmd && repo.build_cmd) {
        const notice = `[NOTICE] No test command for ${repo.name} -- using build command as CI check: ${repo.build_cmd}`;
        if (manager) manager.notifyAgentOutput(task.id, notice).catch(() => {});
      }
      if (!containerName && !repo.ci_on_host) {
        const msg = `[SKIPPED] CI for ${repo.name}: no Docker container available and ci_on_host is not enabled. Register with --allow-ci-on-host to run on host.`;
        logger.warn(msg, { taskId: task.id, repo: repo.name });
        saveNodeOutput(task.id, "ci", msg, false);
        if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
      } else {
        updateTaskStatus(task.id, "ci_running", state);

        for (let round = 0; round < MAX_CI_ROUNDS; round++) {
          logger.info("Running CI", { taskId: task.id, repo: repo.name, round });

          const ciResult = await runCi(repo, workDir, containerName ?? undefined, containerWorkDir, (accumulated) => {
            saveNodeOutput(task.id, "ci", accumulated, false);
          });
          saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

          if (ciResult.success) break;

          if (containerName) discoverSecrets(repo.id, ciResult.output);
          if (round >= MAX_CI_ROUNDS - 1) break;
          if (isTaskCancelled(task.id)) return;

          state = advanceState(state, "fail");
          updateTaskStatus(task.id, "ci_fixing", state);

          const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, repoMcpConfigPath, undefined, sandbox);
          if (fixResult.error) {
            if (isTaskCancelled(task.id)) return;
            break;
          }

          state = advanceState(state, "done");
          state.ci_rounds++;
          updateTaskStatus(task.id, "ci_running", state);
        }
      }
    } else {
      const msg = `[SKIPPED] No test or build command detected for ${repo.name}. CI cannot run.`;
      logger.warn(msg, { taskId: task.id, repo: repo.name });
      saveNodeOutput(task.id, "ci", msg, false);
      if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
    }

    if (isTaskCancelled(task.id)) return;

    // --- Lint (with fix loop) ---
    if (repo.lint_cmd) {
      if (!containerName && !repo.ci_on_host) {
        const msg = `[SKIPPED] Lint for ${repo.name}: no Docker container available and ci_on_host is not enabled.`;
        logger.warn(msg, { taskId: task.id, repo: repo.name });
        saveNodeOutput(task.id, "lint", msg, false);
        if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
      } else {
        updateTaskStatus(task.id, "linting", state);

        for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
          logger.info("Running lint", { taskId: task.id, repo: repo.name, round });

          const lintResult = await executeLint(repo, workDir, containerName ?? undefined, containerWorkDir, (accumulated) => {
            saveNodeOutput(task.id, "lint", accumulated, false);
          });
          saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

          if (lintResult.success) break;

          if (containerName) discoverSecrets(repo.id, lintResult.output);
          if (round >= MAX_LINT_ROUNDS) break;
          if (isTaskCancelled(task.id)) return;

          state = advanceState(state, "errors");
          updateTaskStatus(task.id, "fix_linting", state);

          const fixResult = await executeFixLint(task, repo, workDir, lintResult.output, lintResult.command, repoMcpConfigPath, undefined, sandbox);
          if (fixResult.error) {
            if (isTaskCancelled(task.id)) return;
            break;
          }

          state = advanceState(state, "done");
          state.lint_rounds++;
          updateTaskStatus(task.id, "linting", state);
        }
      }
    } else {
      const msg = `[SKIPPED] No lint command detected for ${repo.name}. Lint cannot run.`;
      logger.warn(msg, { taskId: task.id, repo: repo.name });
      saveNodeOutput(task.id, "lint", msg, false);
      if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
    }

    // Tear down per-repo container (not the sandbox -- that lives for the whole task)
    if (containerName && !sandbox) {
      try { await teardownTaskContainer(task.id); } catch {}
    }
  }

  if (isTaskCancelled(task.id)) return;

  // Tear down sandbox container after all CI/lint is done
  if (sandbox) {
    try { await teardownTaskContainer(task.id); } catch {}
  }

  // === REVIEW: COMMIT + PUSH + CREATE PR PER REPO ===
  logger.info("Task ready for review", { taskId: task.id });

  const notifyError = (msg: string) => {
    logger.error(msg, { taskId: task.id });
    if (manager) manager.notifyAgentOutput(task.id, `[error] ${msg}`).catch(() => {});
  };

  const prUrls: string[] = [];

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    // Check for stray files in task dir that should be in the worktree
    try {
      const tDir = taskDir(task.id);
      const strayResult = await $`find ${tDir} -maxdepth 1 -type f ! -name 'mcp-config.json' ! -name '*.log'`.quiet().nothrow();
      const strays = strayResult.stdout.toString().trim().split("\n").filter(Boolean);
      if (strays.length > 0) {
        logger.warn("Found stray files in task dir (not in repo worktree, will not be committed)", {
          taskId: task.id, files: strays,
        });
        if (manager) {
          manager.notifyAgentOutput(task.id, `[warning] Found ${strays.length} file(s) outside repo worktree that will not be committed: ${strays.join(", ")}`).catch(() => {});
        }
      }
    } catch {}

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
        const statusRow = db.query(
          "SELECT lint_passed, lint_output, ci_passed, ci_output FROM tasks WHERE id = ?"
        ).get(task.id) as { lint_passed: number | null; lint_output: string | null; ci_passed: number | null; ci_output: string | null } | null;

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
          statusRow?.lint_passed != null ? !!statusRow.lint_passed : null,
          statusRow?.ci_passed != null ? !!statusRow.ci_passed : null,
          statusRow?.ci_output ?? null,
          statusRow?.lint_output ?? null
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
  // Verify task still exists (may have been deleted while revision was queued)
  {
    const db = getDb();
    if (!db.query("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) {
      logger.warn("Task deleted before revision could start, aborting", { taskId });
      return;
    }
  }

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

  // Start sandbox container if configured
  let sandbox: SandboxOptions | undefined;
  if (config.sandboxClaude) {
    try {
      const sandboxName = await startSandboxContainer(task.id, taskDir(task.id));
      if (sandboxName) {
        const containerWorkDir = repos.length > 1 ? "/workspace" : `/workspace/${primaryRepo.name}`;
        sandbox = { containerName: sandboxName, containerWorkDir };
      }
    } catch {}
  }

  // Restore MCP config
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(
      task.id, primaryWorkDir, primaryRepo.name,
      sandbox ? { sandboxed: true, containerWorkDir: sandbox.containerWorkDir } : undefined
    );
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
  const { executeUnderstandReview, executeReviewSmallFeedback, executeReviewLargeFeedback } = await import("./nodes/agentic/review-feedback");

  // Advance from review -> understand_review via "revise"
  state = advanceState(state, "revise");

  const previousPlanRow = db.query(
    "SELECT output FROM agent_runs WHERE task_id = ? AND node_name IN ('plan', 'plan_again', 'finalize_plan', 'review_small_feedback', 'review_large_feedback') ORDER BY finished_at DESC LIMIT 1"
  ).get(task.id) as { output: string } | null;
  const previousPlan = previousPlanRow?.output ?? "(no previous plan found)";

  // === UNDERSTAND REVIEW: triage feedback as small or large ===
  updateTaskStatus(task.id, "planning", state);
  logger.info("Triaging review feedback", { taskId: task.id });

  if (manager) {
    manager.notifyAgentOutput(task.id, "Analyzing review feedback to determine revision scope...").catch(() => {});
  }

  const triageResult = await executeUnderstandReview(
    task, primaryRepo, primaryWorkDir, feedback, previousPlan, mcpConfigPath, onThinking, sandbox
  );

  if (triageResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Review triage failed", { taskId: task.id, error: triageResult.error });
    state = advanceState(state, "large"); // default to large path on error
  } else {
    state = advanceState(state, triageResult.verdict);
  }

  if (isTaskCancelled(task.id)) return;

  const planResult = { plan: "" };

  if (triageResult.verdict === "small") {
    // === SMALL: targeted fix plan -> straight to implement ===
    updateTaskStatus(task.id, "planning", state);
    logger.info("Small review feedback -- planning targeted fixes", { taskId: task.id });

    if (manager) {
      manager.notifyAgentOutput(task.id, "Review feedback classified as SMALL -- planning targeted fixes (skipping full scrutiny).").catch(() => {});
    }

    const smallResult = await executeReviewSmallFeedback(
      task, primaryRepo, primaryWorkDir, feedback, previousPlan, mcpConfigPath, onThinking, sandbox
    );

    if (smallResult.error || smallResult.plan.length < 50) {
      if (isTaskCancelled(task.id)) return;
      logger.warn("Small feedback planning failed, falling back to large path", {
        taskId: task.id, error: smallResult.error, outputLen: smallResult.plan.length,
      });
      if (manager) {
        manager.notifyAgentOutput(task.id, "Small feedback plan failed -- falling back to full revision.").catch(() => {});
      }
      // Fall through to the large path below
      triageResult.verdict = "large" as typeof triageResult.verdict;
    } else {
      planResult.plan = smallResult.plan;
      state = advanceState(state, "done"); // -> implement
    }
  }

  if (triageResult.verdict === "large" && !planResult.plan) {
    // === LARGE: revised plan -> scrutinize loop -> implement ===
    updateTaskStatus(task.id, "planning", state);
    logger.info("Large review feedback -- planning structural revision", { taskId: task.id });

    if (manager) {
      manager.notifyAgentOutput(task.id, "Review feedback classified as LARGE -- planning structural revision with full scrutiny.").catch(() => {});
    }

    const largeResult = await executeReviewLargeFeedback(
      task, primaryRepo, primaryWorkDir, feedback, previousPlan, mcpConfigPath, onThinking, sandbox
    );

    if (largeResult.error || largeResult.plan.length < 200) {
      if (isTaskCancelled(task.id)) return;
      logger.error("Large feedback planning failed", { taskId: task.id, error: largeResult.error });
      state = advanceState(state, "error");
      updateTaskStatus(task.id, "error", state);
      return;
    }

    planResult.plan = largeResult.plan;
    state = advanceState(state, "done"); // -> scrutinize

    if (isTaskCancelled(task.id)) return;

    // --- Scrutinize loop (same as runTask) ---
    updateTaskStatus(task.id, "scrutinizing", state);

    const scrutiny1 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planResult.plan, mcpConfigPath, onThinking, sandbox);

    if (!scrutiny1.error) {
      if (isTaskCancelled(task.id)) return;
      state = advanceState(state, "done");
      updateTaskStatus(task.id, "replanning", state);

      const planAgainResult = await executePlanAgain(
        task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, mcpConfigPath, onThinking, sandbox
      );

      if (!planAgainResult.error) {
        if (isTaskCancelled(task.id)) return;
        state = advanceState(state, "done");
        updateTaskStatus(task.id, "scrutinizing", state);

        const scrutiny2 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planAgainResult.plan, mcpConfigPath, onThinking, sandbox);

        if (!scrutiny2.error) {
          if (isTaskCancelled(task.id)) return;
          state = advanceState(state, "done");
          updateTaskStatus(task.id, "finalizing_plan", state);

          const finalPlan = await executeFinalizePlan(
            task, primaryRepo, primaryWorkDir, planAgainResult.plan, scrutiny2.output, mcpConfigPath, onThinking, sandbox
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
  }

  if (isTaskCancelled(task.id)) return;

  // === IMPLEMENT (once, across all repos) ===
  updateTaskStatus(task.id, "implementing", state);
  logger.info("Starting revision implement phase", { taskId: task.id, repoCount: repos.length });

  const implWorkDir = repos.length > 1 ? taskDir(task.id) : workDirs.get(repos[0].name)!;

  const implResult = await executeImplement(
    task, repos, implWorkDir, planResult.plan, mcpConfigPath, onThinking, sandbox
  );

  if (implResult.error) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Revision implementation failed", { taskId: task.id, error: implResult.error });
    state = advanceState(state, "error");
    updateTaskStatus(task.id, "error", state);
    return;
  }

  if (isTaskCancelled(task.id)) return;

  // === PER-REPO: CI -> LINT ===
  state = advanceState(state, "done");

  for (const repo of repos) {
    const workDir = workDirs.get(repo.name)!;

    let containerName: string | null = sandbox?.containerName ?? null;
    let containerWorkDir = sandbox ? `/workspace/${repo.name}` : "/workspace";

    if (!containerName) {
      try {
        containerName = await setupTaskContainer(repo, workDir, task.id, taskDir(task.id));
      } catch (err) {
        logger.error({ err, taskId: task.id }, "failed to set up task container");
        containerName = null;
      }
      containerWorkDir = (containerName && isSandboxContainer(containerName))
        ? `/workspace/${repo.name}`
        : "/workspace";
    }

    let repoMcpConfigPath: string | undefined;
    try {
      repoMcpConfigPath = await generateMcpConfig(
        task.id, workDir, repo.name,
        sandbox ? { sandboxed: true, containerWorkDir } : undefined
      );
    } catch {}

    // --- CI ---
    if (repo.test_cmd || repo.build_cmd) {
      if (!repo.test_cmd && repo.build_cmd) {
        const notice = `[NOTICE] No test command for ${repo.name} -- using build command as CI check: ${repo.build_cmd}`;
        if (manager) manager.notifyAgentOutput(task.id, notice).catch(() => {});
      }
      if (!containerName && !repo.ci_on_host) {
        const msg = `[SKIPPED] CI for ${repo.name}: no Docker container available and ci_on_host is not enabled.`;
        logger.warn(msg, { taskId: task.id, repo: repo.name });
        saveNodeOutput(task.id, "ci", msg, false);
        if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
      } else {
        updateTaskStatus(task.id, "ci_running", state);

        for (let round = 0; round < MAX_CI_ROUNDS; round++) {
          const ciResult = await runCi(repo, workDir, containerName ?? undefined, containerWorkDir, (accumulated) => {
            saveNodeOutput(task.id, "ci", accumulated, false);
          });
          saveNodeOutput(task.id, "ci", ciResult.output, ciResult.success);

          if (ciResult.success) break;
          if (containerName) discoverSecrets(repo.id, ciResult.output);
          if (round >= MAX_CI_ROUNDS - 1) break;
          if (isTaskCancelled(task.id)) return;

          state = advanceState(state, "fail");
          updateTaskStatus(task.id, "ci_fixing", state);

          const fixResult = await executeFixCi(task, repo, workDir, ciResult.output, repoMcpConfigPath, undefined, sandbox);
          if (fixResult.error) { if (isTaskCancelled(task.id)) return; break; }

          state = advanceState(state, "done");
          state.ci_rounds++;
          updateTaskStatus(task.id, "ci_running", state);
        }
      }
    }

    if (isTaskCancelled(task.id)) return;

    // --- Lint ---
    if (repo.lint_cmd) {
      if (!containerName && !repo.ci_on_host) {
        const msg = `[SKIPPED] Lint for ${repo.name}: no Docker container available and ci_on_host is not enabled.`;
        logger.warn(msg, { taskId: task.id, repo: repo.name });
        saveNodeOutput(task.id, "lint", msg, false);
        if (manager) manager.notifyAgentOutput(task.id, msg).catch(() => {});
      } else {
        updateTaskStatus(task.id, "linting", state);

        for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
          const lintResult = await executeLint(repo, workDir, containerName ?? undefined, containerWorkDir, (accumulated) => {
            saveNodeOutput(task.id, "lint", accumulated, false);
          });
          saveNodeOutput(task.id, "lint", lintResult.output, lintResult.success);

          if (lintResult.success) break;
          if (containerName) discoverSecrets(repo.id, lintResult.output);
          if (round >= MAX_LINT_ROUNDS) break;
          if (isTaskCancelled(task.id)) return;

          state = advanceState(state, "errors");
          updateTaskStatus(task.id, "fix_linting", state);

          const fixResult = await executeFixLint(task, repo, workDir, lintResult.output, lintResult.command, repoMcpConfigPath, undefined, sandbox);
          if (fixResult.error) { if (isTaskCancelled(task.id)) return; break; }

          state = advanceState(state, "done");
          state.lint_rounds++;
          updateTaskStatus(task.id, "linting", state);
        }
      }
    }

    if (containerName && !sandbox) {
      try { await teardownTaskContainer(task.id); } catch {}
    }
  }

  if (isTaskCancelled(task.id)) return;

  // Tear down sandbox container
  if (sandbox) {
    try { await teardownTaskContainer(task.id); } catch {}
  }

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

          const prMetadata = generatePrMetadata(task, planOutput, diffStat, null, null, null, null);
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

/**
 * Detect the install command for a repo based on lockfiles/manifests.
 * Returns null if no install is needed or can't be determined.
 */
function detectInstallCmd(workDir: string): string | null {
  if (existsSync(join(workDir, "bun.lockb")) || existsSync(join(workDir, "bunfig.toml"))) {
    return "bun install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "package-lock.json"))) {
    return "npm ci";
  }
  if (existsSync(join(workDir, "yarn.lock"))) {
    return "yarn install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "pnpm-lock.yaml"))) {
    return "pnpm install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "package.json"))) {
    return "npm install";
  }
  if (existsSync(join(workDir, "requirements.txt"))) {
    return "pip install -r requirements.txt";
  }
  if (existsSync(join(workDir, "pyproject.toml"))) {
    return "pip install -e .";
  }
  if (existsSync(join(workDir, "go.mod"))) {
    return "go mod download";
  }
  return null;
}

async function runCi(
  repo: Repo,
  workDir: string,
  containerName?: string,
  containerWorkDir: string = "/workspace",
  onChunk?: (accumulated: string) => void
): Promise<{ success: boolean; output: string }> {
  const commands: string[] = [];

  // When running in a container, install dependencies first
  if (containerName) {
    const installCmd = detectInstallCmd(workDir);
    if (installCmd) {
      commands.push(installCmd);
    }
  }

  if (repo.build_cmd) commands.push(repo.build_cmd);
  if (repo.test_cmd) commands.push(repo.test_cmd);

  let allOutput = "";

  const emit = (text: string) => {
    allOutput += text;
    onChunk?.(allOutput);
  };

  if (!repo.test_cmd && repo.build_cmd) {
    const notice = `[NOTICE] No test command detected for ${repo.name}. Using build command as CI check: ${repo.build_cmd}\n`;
    logger.warn(notice, { repo: repo.name, build_cmd: repo.build_cmd });
    emit(notice);
  }

  const decoder = new TextDecoder();

  for (const cmd of commands) {
    logger.info("Running CI command", { cmd, containerName });
    emit(`\n$ ${cmd}\n`);

    try {
      const argv = containerName
        ? ["docker", "exec", "-w", containerWorkDir, containerName, "sh", "-c", cmd]
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
