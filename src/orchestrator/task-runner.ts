import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import type { Task, Repo, BlueprintState, TaskStatus, BlueprintNodeType } from "../shared/types";
import { createInitialState, advanceState, restartFromPhase } from "./blueprint";
import { NotFoundError } from "./errors";
import { executePlan } from "./nodes/agentic/plan";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTaskClone, generateBranchName } from "../workspace/git";
import { ensureTaskDir, taskDir, } from "../workspace/manager";
import { killTaskSubprocesses } from "./subprocess-registry";
import { indexRepo } from "../knowledge/indexer";
import { generateMcpConfig } from "./subprocess";
import { teardownTaskContainer, startSandboxContainer } from "../workspace/docker-exec";
import type { SandboxOptions } from "./nodes/agentic/types";
import { getMessagingManager } from "../messaging/manager";
import { ClaudeCodeCliAgent, type AgentEvent } from "../agent";
import { StreamFormatter } from "../cli/stream-formatter";

const _MAX_LINT_ROUNDS = 2;
const _MAX_CI_ROUNDS = 2;
const INPUT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INPUT_POLL_INTERVAL_MS = 2000;

import type { MessagingManager } from "../messaging/manager";

/**
 * Create an onEvent callback that routes agent stream events to a messaging
 * channel as clean, batched messages.
 *
 * - tool_call  -> one message per tool call (e.g. "Read: file_path="/data/..."")
 * - text       -> debounce-batched into single messages (2s window)
 * - thinking   -> skipped (too verbose for chat)
 * - tool_result -> skipped (can be large)
 *
 * @param notify  Called with each outbound message string.
 */
export function makeAgentOutputForwarder(
  notify: (msg: string) => void
): (event: AgentEvent) => void {
  const FLUSH_INTERVAL_MS = 2000;
  let textBuffer = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;

  const flushText = () => {
    if (textBuffer.trim()) {
      notify(textBuffer);
      textBuffer = "";
    }
    textTimer = null;
  };

  const formatter = new StreamFormatter(false, (output) => {
    if (output.type === "tool") {
      // Flush any pending text first so messages arrive in order
      if (textTimer) { clearTimeout(textTimer); textTimer = null; }
      flushText();
      notify(output.content);
    } else if (output.type === "text") {
      // StreamFormatter emits text immediately; outer wrapper owns debounce
      textBuffer += output.content;
      if (!textTimer) {
        textTimer = setTimeout(flushText, FLUSH_INTERVAL_MS);
      }
    }
    // type === "thinking" and type === "result" (tool_result) are silently dropped
  });

  return (event: AgentEvent) => {
    if (event.type === "tool_call") {
      formatter.push("tool_use", `Tool: ${event.toolName}\n${JSON.stringify(event.args ?? {})}`);
      formatter.flush();
    } else if (event.type === "text") {
      if (event.content) formatter.push("text", event.content);
    }
    // "thinking" and "tool_result" are intentionally skipped
  };
}

export function updateTaskStatus(taskId: string, status: TaskStatus, blueprintState?: BlueprintState) {
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

function _saveNodeOutput(
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

function _generatePrMetadata(
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
  const summarySection = planOutput.match(/^#{1,3}\s*Summary\n+([\s\S]*?)(?=\n#{1,3}\s|\n---|Z)/m);
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
  const summaryMatch = planOutput.match(/^#{1,3}\s*Summary\n+([\s\S]*?)(?=\n#{1,3}\s|\n---|Z)/m);
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
  await killTaskSubprocesses(taskId);

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
    // Pre-plan runs before sandbox/MCP are set up -- use a bare agent.
    const prePlanAgent = new ClaudeCodeCliAgent({});
    const prePlanResult = await executePrePlan(task, prePlanAgent, { hasMcp: false });

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
      const sandboxResult = await startSandboxContainer(task.id, taskDir(task.id));
      if (sandboxResult) {
        const workspaceBase = sandboxResult.workspacePath;
        const containerWorkDir = repos.length > 1
          ? workspaceBase
          : `${workspaceBase}/${primaryRepo.name}`;
        sandbox = { containerName: sandboxResult.containerName, containerWorkDir, workspaceBase };
        logger.info("Sandbox container started for task", { taskId: task.id, containerName: sandboxResult.containerName, workspacePath: workspaceBase });
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

  // Construct the agent once for this task (used by all parent-level nodes).
  const agent = new ClaudeCodeCliAgent({
    sandbox: sandbox
      ? { containerName: sandbox.containerName, containerWorkDir: sandbox.containerWorkDir }
      : undefined,
    mcpConfigPath,
  });
  const hasMcp = !!mcpConfigPath;

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
  const onThinking = manager
    ? makeAgentOutputForwarder((msg) => manager.notifyAgentOutput(task.id, msg).catch(() => {}))
    : () => {};
  const { executeScrutinize, executePlanAgain, executeFinalizePlan } = await import("./nodes/agentic/scrutinize");

  const { buildPlanPrompt } = await import("./context-builder");

  // --- Plan (round 1) ---
  updateTaskStatus(task.id, "planning", state);
  logger.info("Starting plan phase", { taskId: task.id });

  // Unified plan prompt works for single or multi-repo
  const planPrompt = await buildPlanPrompt(task, repos);

  const planResult = await executePlan(
    task, primaryRepo, primaryWorkDir, agent,
    { onEvent: onThinking, promptOverride: planPrompt, hasMcp }
  );

  // A valid plan must either contain a "### Summary" section or a
  // "### Execution Plan"/"### Per-Repo Plans" section. The length is NOT
  // a reliable signal -- trivial tasks legitimately produce short plans.
  // We only reject when the agent errored or produced no recognizable
  // structured output (i.e. burned all turns reading files without writing).
  const planHasStructure = /^#{1,3}\s*(Summary|Execution Plan|Per-Repo Plans)\b/m.test(planResult.plan);
  if (planResult.error || !planHasStructure) {
    if (isTaskCancelled(task.id)) return;
    logger.error("Planning failed or produced no structured output", {
      taskId: task.id,
      error: planResult.error,
      outputLen: planResult.plan.length,
      hasStructure: planHasStructure,
    });
    if (manager) {
      const reason = planResult.error
        ? `agent error: ${planResult.error}`
        : `no structured plan sections found (agent may have run out of turns while exploring)`;
      manager.notifyAgentOutput(task.id, `[error] Plan phase failed: ${reason}`).catch(() => {});
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

  const scrutiny1 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planResult.plan, agent, { onEvent: onThinking, hasMcp });

  const noIssuesPattern = /\bNO\s+ISSUES\b/i;

  if (scrutiny1.error) {
    if (isTaskCancelled(task.id)) return;
    logger.warn("Scrutiny failed, proceeding with original plan", { taskId: task.id });
    state = advanceState(state, "error");
  } else if (noIssuesPattern.test(scrutiny1.output)) {
    if (isTaskCancelled(task.id)) return;
    logger.info("Scrutiny found no issues, skipping to finalize", { taskId: task.id });

    state = advanceState(state, "done");
    updateTaskStatus(task.id, "finalizing_plan", state);

    const finalPlan = await executeFinalizePlan(
      task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, agent, { onEvent: onThinking, hasMcp }
    );

    const finalHasStructure = /^#{1,3}\s*(Summary|Execution Plan|Per-Repo Plans)\b/m.test(finalPlan.plan ?? "");
    if (!finalPlan.error && finalHasStructure) {
      planResult.plan = finalPlan.plan;
    } else {
      logger.warn("Finalize output unstructured or failed, using original plan", { taskId: task.id, len: finalPlan.plan?.length });
    }
    state = advanceState(state, "done");
  } else {
    if (isTaskCancelled(task.id)) return;

    state = advanceState(state, "done");
    updateTaskStatus(task.id, "replanning", state);
    logger.info("Revising plan based on scrutiny", { taskId: task.id });

    const planAgainResult = await executePlanAgain(
      task, primaryRepo, primaryWorkDir, planResult.plan, scrutiny1.output, agent, { onEvent: onThinking, hasMcp }
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

      const scrutiny2 = await executeScrutinize(task, primaryRepo, primaryWorkDir, planAgainResult.plan, agent, { onEvent: onThinking, hasMcp });

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
          task, primaryRepo, primaryWorkDir, planAgainResult.plan, scrutiny2.output, agent, { onEvent: onThinking, hasMcp }
        );

        const finalHasStructure = /^#{1,3}\s*(Summary|Execution Plan|Per-Repo Plans)\b/m.test(finalPlan.plan ?? "");
        if (!finalPlan.error && finalHasStructure) {
          planResult.plan = finalPlan.plan;
        } else {
          logger.warn("Finalize output unstructured or failed, using revised plan", { taskId: task.id, len: finalPlan.plan?.length });
          planResult.plan = planAgainResult.plan;
        }
        state = advanceState(state, "done");
      }
    }
  }

  // Sanity check: log if the final plan lacks any structured section header.
  if (!/^#{1,3}\s*(Summary|Execution Plan|Per-Repo Plans)\b/m.test(planResult.plan)) {
    logger.warn("Final plan lacks structured sections, task may produce poor results", { taskId: task.id, len: planResult.plan.length });
  }

  if (isTaskCancelled(task.id)) return;

  // === Spawn child tasks (all tasks use this path: 1 repo -> 1 child, N repos -> N children) ===
  {
    const { extractRepoExcerpts } = await import("./plan-splitter");
    const { runChildTask, checkParentCompletion } = await import("./child-task-runner");
    const { ulid } = await import("ulid");

    const db = getDb();
    updateTaskStatus(task.id, "spawning_children", state);
    logger.info("Spawning child tasks", { taskId: task.id, repoCount: repos.length });

    if (manager) {
      manager.notifyAgentOutput(task.id, `Spawning ${repos.length} child task(s): ${repos.map((r) => r.name).join(", ")}`).catch(() => {});
    }

    const excerpts = extractRepoExcerpts(planResult.plan, repos);

    // Create child task rows
    const childIds: string[] = [];
    for (const repo of repos) {
      const childId = ulid();
      const excerpt = excerpts.get(repo.name) ?? planResult.plan;
      db.run(
        `INSERT INTO child_tasks (id, parent_task_id, repo_id, status, branch_name, plan_excerpt)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [childId, task.id, repo.id, branchName, excerpt]
      );
      childIds.push(childId);
      logger.info("Created child task", { childId, parentTaskId: task.id, repo: repo.name });
    }

    updateTaskStatus(task.id, "waiting_for_children", state);

    // Launch all children in parallel
    const results = await Promise.allSettled(
      childIds.map((id) => runChildTask(id))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        logger.error("Child task runner crashed", { childId: childIds[i], error: String(result.reason) });
        const now = new Date().toISOString();
        db.run("UPDATE child_tasks SET status = 'error', updated_at = ? WHERE id = ?", [now, childIds[i]]);
      }
    }

    // Check if all children are done
    checkParentCompletion(task.id);

    // Tear down sandbox if we started one for planning
    if (sandbox) {
      try { await teardownTaskContainer(task.id); } catch {}
    }

    return; // Parent task is done orchestrating
  }
}

export async function restartTaskPhase(taskId: string, phase: string): Promise<void> {
  const db = getDb();
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError(`Task not found: ${taskId}`);
  const currentState: BlueprintState = row.blueprint_state
    ? JSON.parse(row.blueprint_state as string)
    : createInitialState();
  const newState = restartFromPhase(currentState, phase as BlueprintNodeType);
  await killTaskSubprocesses(taskId);
  db.run(
    "UPDATE tasks SET status = 'running', blueprint_state = ? WHERE id = ?",
    [JSON.stringify(newState), taskId]
  );
  runTask(taskId).catch((err) =>
    logger.error("restartTaskPhase: runTask failed", { taskId, err })
  );
}

export async function reviseTask(taskId: string, feedback: string): Promise<void> {
  const db = getDb();
  if (!db.query('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
    logger.warn('Task deleted before revision could start, aborting', { taskId });
    return;
  }

  logger.info('Revising task via child tasks', { taskId });

  const manager = getMessagingManager();
  if (manager) {
    manager.notifyAgentOutput(taskId, 'Starting revision...').catch(() => {});
  }

  // Find all children for this task. If none exist (legacy task), spawn them now.
  const children = db.query(
    'SELECT id, status FROM child_tasks WHERE parent_task_id = ?'
  ).all(taskId) as Array<{ id: string; status: string }>;

  if (children.length === 0) {
    logger.warn('No child tasks found for revision -- task may be from before child task architecture', { taskId });
    if (manager) {
      manager.notifyAgentOutput(taskId, '[error] Cannot revise: no child tasks found. Cancel and re-submit the task.').catch(() => {});
    }
    updateTaskStatus(taskId, 'error');
    return;
  }

  updateTaskStatus(taskId, 'waiting_for_children');

  // Revise each child task in parallel. Children handle their own triage,
  // implementation, CI/lint, and re-push.
  const { reviseChildTask, checkParentCompletion } = await import('./child-task-runner');

  await Promise.allSettled(
    children.map((c) => reviseChildTask(c.id, feedback))
  );

  checkParentCompletion(taskId);
}

