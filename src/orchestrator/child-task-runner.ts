/**
 * Child task runner for multi-repo tasks.
 *
 * Each child task owns one repo's implementation, CI/lint, and review cycle.
 * The parent task handles planning; children handle execution.
 */

import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import type { Repo, BlueprintState, BlueprintNodeType, ChildTaskStatus } from "../shared/types";
import { createChildInitialState, advanceState, restartFromPhase } from "./blueprint";
import { killTaskSubprocesses } from "./subprocess-registry";
import { NotFoundError } from "./errors";
import { executeImplement } from "./nodes/agentic/implement";
import { executeFixLint } from "./nodes/agentic/fix-lint";
import { executeFixCi } from "./nodes/agentic/fix-ci";
import { executeLint } from "./nodes/deterministic/lint";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreeDir, taskDir } from "../workspace/manager";
import { generateMcpConfig } from "./subprocess";
import { setupTaskContainer, teardownTaskContainer, startSandboxContainer } from "../workspace/docker-exec";
import { isSandboxContainer } from "../workspace/docker-exec";
import { discoverSecrets } from "../workspace/secret-discovery";
import { getMessagingManager } from "../messaging/manager";
import { isGiteaConfigured, createPullRequest, rewriteGiteaUrl } from "../gitea/client";
import { ensureRepoOnGitea, pushBranchToGitea } from "../gitea/repo-sync";
import { startReviewPoller, seedCursors } from "../gitea/review-poller";
import { $ } from "bun";
import type { SandboxOptions } from "./nodes/agentic/types";
import { ClaudeCodeCliAgent } from "../agent";
import { makeAgentOutputForwarder } from "./task-runner";
import { claudeText } from "../shared/claude-cli";

async function generatePrTitle(taskDescription: string, planExcerpt: string): Promise<string> {
  const fallback = taskDescription.length > 60
    ? `${taskDescription.slice(0, 60)}...`
    : taskDescription;
  try {
    const result = await claudeText({
      prompt: [
        "Generate a concise pull request title for the following task.",
        "Rules: imperative mood, max 72 characters, no trailing period, no quotes, no \"hoto:\" prefix.",
        "",
        `Task: ${taskDescription}`,
        `Plan summary: ${planExcerpt.slice(0, 500)}`,
        "",
        "Reply with only the title, nothing else.",
      ].join("\n"),
    });
    const title = result.trim().replace(/^["']|["']$/g, "");
    return title.length > 0 ? title : fallback;
  } catch (err) {
    logger.warn("generatePrTitle failed, using fallback", { error: String(err) });
    return fallback;
  }
}

const MAX_LINT_ROUNDS = 2;
const MAX_CI_ROUNDS = 2;

function updateChildStatus(childId: string, status: ChildTaskStatus, blueprintState?: BlueprintState) {
  const db = getDb();
  const now = new Date().toISOString();
  if (blueprintState) {
    db.run(
      "UPDATE child_tasks SET status = ?, blueprint_state = ?, updated_at = ? WHERE id = ?",
      [status, JSON.stringify(blueprintState), now, childId]
    );
  } else {
    db.run(
      "UPDATE child_tasks SET status = ?, updated_at = ? WHERE id = ?",
      [status, now, childId]
    );
  }
}

function saveChildNodeOutput(childId: string, node: "lint" | "ci", output: string, passed: boolean, parentTaskId: string) {
  const db = getDb();
  if (node === "lint") {
    db.run("UPDATE child_tasks SET lint_output = ?, lint_passed = ? WHERE id = ?", [output, passed ? 1 : 0, childId]);
  } else {
    db.run("UPDATE child_tasks SET ci_output = ?, ci_passed = ? WHERE id = ?", [output, passed ? 1 : 0, childId]);
  }
  try {
    db.prepare(
      `INSERT INTO task_ci_lint_runs (task_id, child_task_id, run_type, output, passed)
       VALUES (?, ?, ?, ?, ?)`
    ).run(parentTaskId, childId, node, output, passed ? 1 : 0);
  } catch (err) {
    logger.warn("Failed to insert ci/lint run history row", { err, childId, parentTaskId });
  }
}

function isChildCancelled(childId: string): boolean {
  const db = getDb();
  const row = db.query("SELECT status FROM child_tasks WHERE id = ?").get(childId) as { status: string } | null;
  return row?.status === "cancelled";
}

/** Notify parent's messaging channels with [repo-name] prefix. */
function notifyParent(parentTaskId: string, repoName: string, message: string) {
  const manager = getMessagingManager();
  if (manager) {
    manager.notifyAgentOutput(parentTaskId, `[${repoName}] ${message}`).catch(() => {});
  }
}

function detectInstallCmd(workDir: string): string | null {
  if (existsSync(join(workDir, "bun.lockb")) || existsSync(join(workDir, "bunfig.toml"))) {
    return "bun install --frozen-lockfile";
  }
  if (existsSync(join(workDir, "package-lock.json"))) return "npm ci";
  if (existsSync(join(workDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(workDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(workDir, "package.json"))) return "npm install";
  if (existsSync(join(workDir, "requirements.txt"))) return "pip install -r requirements.txt";
  if (existsSync(join(workDir, "pyproject.toml"))) return "pip install -e .";
  if (existsSync(join(workDir, "go.mod"))) return "go mod download";
  return null;
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

/**
 * Run a child task: implement -> CI/lint -> commit/push/PR -> review.
 * Called in parallel for each repo in a multi-repo task.
 */
export async function runChildTask(childId: string): Promise<void> {
  const db = getDb();

  const childRow = db.query("SELECT * FROM child_tasks WHERE id = ?").get(childId) as Record<string, unknown> | null;
  if (!childRow) {
    logger.error("Child task not found", { childId });
    return;
  }

  const parentTaskId = childRow.parent_task_id as string;
  const repoId = childRow.repo_id as number;
  const planExcerpt = childRow.plan_excerpt as string;
  const branchName = childRow.branch_name as string;

  const repoRow = db.query("SELECT * FROM repos WHERE id = ?").get(repoId) as Record<string, unknown> | null;
  if (!repoRow) {
    logger.error("Repo not found for child task", { childId, repoId });
    updateChildStatus(childId, "error");
    return;
  }

  const repo = parseRepoRow(repoRow);
  const workDir = worktreeDir(parentTaskId, repo.name);

  // Get parent task info for context
  const parentRow = db.query("SELECT title, description FROM tasks WHERE id = ?").get(parentTaskId) as { title: string; description: string } | null;
  if (!parentRow) {
    logger.error("Parent task not found", { childId, parentTaskId });
    updateChildStatus(childId, "error");
    return;
  }

  logger.info("Starting child task", { childId, parentTaskId, repo: repo.name });
  notifyParent(parentTaskId, repo.name, "Starting implementation...");

  // Set up sandbox if configured
  let sandbox: SandboxOptions | undefined;
  if (config.sandboxClaude) {
    try {
      const parentTaskDir = taskDir(parentTaskId);
      const sandboxResult = await startSandboxContainer(childId, parentTaskDir);
      if (sandboxResult) {
        sandbox = {
          containerName: sandboxResult.containerName,
          containerWorkDir: `${sandboxResult.workspacePath}/${repo.name}`,
          workspaceBase: sandboxResult.workspacePath,
        };
        logger.info("Sandbox started for child task", { childId, containerName: sandboxResult.containerName });
      }
    } catch (err) {
      logger.warn("Sandbox setup failed for child task, falling back to host", { childId, error: String(err) });
    }
  }

  // Generate MCP config
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(
      parentTaskId, workDir, repo.name,
      sandbox ? { sandboxed: true, containerWorkDir: sandbox.containerWorkDir } : undefined
    );
  } catch {}

  // Construct the agent for this child (used by implement, fix-ci, fix-lint).
  const agent = new ClaudeCodeCliAgent({
    sandbox: sandbox
      ? { containerName: sandbox.containerName, containerWorkDir: sandbox.containerWorkDir }
      : undefined,
    mcpConfigPath,
    registryKey: childId,
  });
  const hasMcp = !!mcpConfigPath;
  const { onEvent, done: doneForwarding } = makeAgentOutputForwarder((msg) => notifyParent(parentTaskId, repo.name, msg));

  // Build the implement prompt. The plan_excerpt already contains:
  // - The shared Summary and Cross-Repo Context (from the parent's finalize-plan)
  // - This repo's specific Execution Plan
  // The child does NOT see other repos' implementation details -- that's the point.
  const implementPrompt = [
    `Implement the changes for the **${repo.name}** repository.`,
    "",
    "## Original Task",
    parentRow.description,
    "",
    "## Your Plan",
    planExcerpt,
    "",
    "You are responsible for ONLY the changes in this repo. Other repos in this task have their own implementations running in parallel.",
  ].join("\n");

  let state = createChildInitialState();

  // === IMPLEMENT ===
  updateChildStatus(childId, "implementing", state);

  const taskObj = { id: parentTaskId, title: parentRow.title, description: parentRow.description, repo_id: repo.id, status: "implementing" as const, blueprint_state: null, branch_name: branchName, source: "cli" as const, use_full_copy: false, created_at: "", updated_at: "", child_task_id: childId };

  let implResult: Awaited<ReturnType<typeof executeImplement>>;
  try {
    implResult = await executeImplement(
      taskObj,
      [repo],
      workDir,
      implementPrompt,
      agent,
      {
        onEvent,
        hasMcp,
        effectiveWorkDir: sandbox ? `${sandbox.workspaceBase}/${repo.name}` : workDir,
      },
    );
  } finally {
    doneForwarding();
  }

  if (implResult.error) {
    if (isChildCancelled(childId)) return;
    logger.error("Child task implementation failed", { childId, repo: repo.name, error: implResult.error });
    notifyParent(parentTaskId, repo.name, `Implementation failed: ${implResult.error}`);
    state = advanceState(state, "error");
    updateChildStatus(childId, "error", state);
    return;
  }

  if (isChildCancelled(childId)) return;

  // === CI/LINT ===
  state = advanceState(state, "done"); // implement -> lint

  let containerName: string | null = sandbox?.containerName ?? null;
  let containerWorkDir = sandbox ? `${sandbox.workspaceBase}/${repo.name}` : "/workspace";

  if (!containerName) {
    try {
      containerName = await setupTaskContainer(repo, workDir, childId, taskDir(parentTaskId));
    } catch {
      containerName = null;
    }
    containerWorkDir = (containerName && isSandboxContainer(containerName))
      ? `/workspace/${repo.name}`
      : "/workspace";
  }

  // --- CI ---
  if (repo.test_cmd || repo.build_cmd) {
    if (!repo.test_cmd && repo.build_cmd) {
      notifyParent(parentTaskId, repo.name, `No test command -- using build as CI check: ${repo.build_cmd}`);
    }
    if (!containerName && !repo.ci_on_host) {
      const msg = "CI skipped: no Docker container and ci_on_host not enabled.";
      saveChildNodeOutput(childId, "ci", msg, false, parentTaskId);
      notifyParent(parentTaskId, repo.name, msg);
    } else {
      updateChildStatus(childId, "ci_running", state);

      for (let round = 0; round < MAX_CI_ROUNDS; round++) {
        const ciResult = await runCiCommand(repo, workDir, containerName ?? undefined, containerWorkDir);
        saveChildNodeOutput(childId, "ci", ciResult.output, ciResult.success, parentTaskId);

        if (ciResult.success) break;
        if (containerName) discoverSecrets(repo.id, ciResult.output);
        if (round >= MAX_CI_ROUNDS - 1) break;
        if (isChildCancelled(childId)) return;

        state = advanceState(state, "fail");
        updateChildStatus(childId, "ci_fixing", state);
        notifyParent(parentTaskId, repo.name, `CI failed (round ${round + 1}), fixing...`);

        const fixResult = await executeFixCi(
          { ...taskObj, status: "ci_fixing" as const },
          repo, workDir, ciResult.output, agent, { onEvent, hasMcp }
        );
        if (fixResult.error) { if (isChildCancelled(childId)) return; break; }

        state = advanceState(state, "done");
        state.ci_rounds++;
        updateChildStatus(childId, "ci_running", state);
      }
    }
  }

  if (isChildCancelled(childId)) return;

  // --- Lint ---
  if (repo.lint_cmd) {
    if (!containerName && !repo.ci_on_host) {
      const msg = "Lint skipped: no Docker container and ci_on_host not enabled.";
      saveChildNodeOutput(childId, "lint", msg, false, parentTaskId);
      notifyParent(parentTaskId, repo.name, msg);
    } else {
      updateChildStatus(childId, "linting", state);

      for (let round = 0; round <= MAX_LINT_ROUNDS; round++) {
        const lintResult = await executeLint(repo, workDir, containerName ?? undefined, containerWorkDir);
        saveChildNodeOutput(childId, "lint", lintResult.output, lintResult.success, parentTaskId);

        if (lintResult.success) break;
        if (containerName) discoverSecrets(repo.id, lintResult.output);
        if (round >= MAX_LINT_ROUNDS) break;
        if (isChildCancelled(childId)) return;

        state = advanceState(state, "errors");
        updateChildStatus(childId, "fix_linting", state);

        const fixResult = await executeFixLint(
          { ...taskObj, status: "fix_linting" as const },
          repo, workDir, lintResult.output, lintResult.command, agent, { onEvent, hasMcp }
        );
        if (fixResult.error) { if (isChildCancelled(childId)) return; break; }

        state = advanceState(state, "done");
        state.lint_rounds++;
        updateChildStatus(childId, "linting", state);
      }
    }
  }

  // Tear down container (not sandbox -- that lives for the child's lifetime)
  if (containerName && !sandbox) {
    try { await teardownTaskContainer(childId); } catch {}
  }
  if (sandbox) {
    try { await teardownTaskContainer(childId); } catch {}
  }

  if (isChildCancelled(childId)) return;

  // === COMMIT + PUSH + PR ===
  notifyParent(parentTaskId, repo.name, "Committing and pushing...");

  try {
    await $`git -C ${workDir} add -A`.quiet();
    const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
    if (hasChanges.exitCode !== 0) {
      await $`git -C ${workDir} commit -m ${`hoto: ${parentRow.title}`}`.quiet();
      logger.info("Child task committed changes", { childId, repo: repo.name });
    } else {
      logger.warn("Child task has no changes to commit", { childId, repo: repo.name });
      notifyParent(parentTaskId, repo.name, "No changes to commit.");
      updateChildStatus(childId, "committed", state);
      return;
    }
  } catch (err) {
    logger.error("Child task commit failed", { childId, repo: repo.name, error: String(err) });
    notifyParent(parentTaskId, repo.name, `Commit failed: ${err}`);
    updateChildStatus(childId, "error", state);
    return;
  }

  if (!isGiteaConfigured()) {
    logger.info("Gitea not configured, marking child committed without PR", { childId, repo: repo.name });
    notifyParent(parentTaskId, repo.name, "Committed locally (no Gitea configured).");
    updateChildStatus(childId, "committed", state);
    checkParentCompletion(parentTaskId);
    return;
  }

  try {
    await ensureRepoOnGitea(repo.path, repo.name);
    const { getDefaultBranch } = await import("../workspace/git");
    const baseBranch = await getDefaultBranch(repo.path);
    await pushBranchToGitea(workDir, repo.path, repo.name, branchName);

    const prTitle = await generatePrTitle(parentRow.title, planExcerpt);
    const pr = await createPullRequest(
      repo.name, branchName, baseBranch,
      `hoto: ${prTitle}`,
      `Child task of parent ${parentTaskId}\n\n## Plan\n${planExcerpt}`
    );

    const prUrl = rewriteGiteaUrl(pr.html_url);

    db.run("UPDATE child_tasks SET pr_number = ?, pr_url = ? WHERE id = ?", [pr.number, prUrl, childId]);

    // Insert into task_prs so the review poller gets a real repo_id and messaging
    // manager can find the PR URL for ready-for-review notifications.
    db.run(
      "INSERT OR REPLACE INTO task_prs (task_id, repo_id, pr_number, pr_url) VALUES (?, ?, ?, ?)",
      [parentTaskId, repo.id, pr.number, prUrl]
    );

    logger.info("Child task PR created", { childId, repo: repo.name, prNumber: pr.number, url: prUrl });
    notifyParent(parentTaskId, repo.name, `PR created: ${prUrl}`);

    const messagingManager = getMessagingManager();
    if (messagingManager) {
      await messagingManager.notifyPRCreated(parentTaskId, repo.name, prUrl, parentRow.title);
    }

    // Start review poller (uses parent task ID for channel notifications)
    await seedCursors(parentTaskId, repo.name, pr.number);
    startReviewPoller(parentTaskId, repo.name, repo.path, branchName, pr.number);
  } catch (err) {
    logger.error("Child task push/PR failed", { childId, repo: repo.name, error: String(err) });
    notifyParent(parentTaskId, repo.name, `Push/PR failed: ${err}`);
    updateChildStatus(childId, "error", state);
    return;
  }

  // Set review status
  state = advanceState(state, "pass"); // ci -> review (or lint -> ci -> review depending on path)
  updateChildStatus(childId, "review", state);
  notifyParent(parentTaskId, repo.name, "Ready for review.");
}

/** Simple CI command runner (same as task-runner's runCi but without the parent-task coupling). */
async function runCiCommand(
  repo: Repo,
  workDir: string,
  containerName?: string,
  containerWorkDir: string = "/workspace",
): Promise<{ success: boolean; output: string }> {
  const commands: string[] = [];

  if (containerName) {
    const installCmd = detectInstallCmd(workDir);
    if (installCmd) commands.push(installCmd);
  }

  if (repo.build_cmd) commands.push(repo.build_cmd);
  if (repo.test_cmd) commands.push(repo.test_cmd);

  let allOutput = "";
  const decoder = new TextDecoder();

  for (const cmd of commands) {
    logger.info("Running CI command (child)", { cmd, containerName });
    allOutput += `\n$ ${cmd}\n`;

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
          allOutput += decoder.decode(value, { stream: true });
        }
      };

      await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
      await proc.exited;

      if (proc.exitCode !== 0) {
        return { success: false, output: allOutput };
      }
    } catch (err) {
      allOutput += `Error: ${err}`;
      return { success: false, output: allOutput };
    }
  }

  return { success: true, output: allOutput };
}

/**
 * Revise a child task after PR rejection.
 * Simplified revision: understand-review -> plan fix -> implement -> CI/lint -> re-push.
 */
export async function reviseChildTask(childId: string, feedback: string): Promise<void> {
  const db = getDb();

  const childRow = db.query("SELECT * FROM child_tasks WHERE id = ?").get(childId) as Record<string, unknown> | null;
  if (!childRow) {
    logger.error("Child task not found for revision", { childId });
    return;
  }

  const parentTaskId = childRow.parent_task_id as string;
  const repoId = childRow.repo_id as number;
  const planExcerpt = childRow.plan_excerpt as string;
  const branchName = childRow.branch_name as string;

  const repoRow = db.query("SELECT * FROM repos WHERE id = ?").get(repoId) as Record<string, unknown> | null;
  if (!repoRow) return;

  const repo = parseRepoRow(repoRow);
  const workDir = worktreeDir(parentTaskId, repo.name);

  const parentRow = db.query("SELECT title, description FROM tasks WHERE id = ?").get(parentTaskId) as { title: string; description: string } | null;
  if (!parentRow) return;

  logger.info("Starting child task revision", { childId, repo: repo.name });
  notifyParent(parentTaskId, repo.name, "Starting revision based on review feedback...");

  // Build a simple task object for the agentic nodes
  const taskProxy = {
    id: parentTaskId, title: parentRow.title, description: parentRow.description,
    repo_id: repo.id, status: "implementing" as const, blueprint_state: null,
    branch_name: branchName, source: "cli" as const, use_full_copy: false,
    created_at: "", updated_at: "", child_task_id: childId,
  };

  // Set up sandbox
  let sandbox: SandboxOptions | undefined;
  if (config.sandboxClaude) {
    try {
      const sandboxResult = await startSandboxContainer(childId, taskDir(parentTaskId));
      if (sandboxResult) {
        sandbox = {
          containerName: sandboxResult.containerName,
          containerWorkDir: `${sandboxResult.workspacePath}/${repo.name}`,
          workspaceBase: sandboxResult.workspacePath,
        };
      }
    } catch {}
  }

  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = await generateMcpConfig(
      parentTaskId, workDir, repo.name,
      sandbox ? { sandboxed: true, containerWorkDir: sandbox.containerWorkDir } : undefined
    );
  } catch {}

  const agent = new ClaudeCodeCliAgent({
    sandbox: sandbox
      ? { containerName: sandbox.containerName, containerWorkDir: sandbox.containerWorkDir }
      : undefined,
    mcpConfigPath,
  });
  const hasMcp = !!mcpConfigPath;
  const { onEvent, done: doneForwarding } = makeAgentOutputForwarder((msg) => notifyParent(parentTaskId, repo.name, msg));

  // Triage + plan fix
  const { executeUnderstandReview, executeReviewSmallFeedback, executeReviewLargeFeedback } = await import("./nodes/agentic/review-feedback");

  const triageResult = await executeUnderstandReview(
    taskProxy, repo, workDir, feedback, planExcerpt, agent, { hasMcp }
  );

  let fixPlan: string;
  if (triageResult.verdict === "small") {
    notifyParent(parentTaskId, repo.name, "Small fix -- planning targeted changes.");
    const result = await executeReviewSmallFeedback(
      taskProxy, repo, workDir, feedback, planExcerpt, agent, { hasMcp }
    );
    fixPlan = result.plan;
  } else {
    notifyParent(parentTaskId, repo.name, "Large fix -- replanning.");
    const result = await executeReviewLargeFeedback(
      taskProxy, repo, workDir, feedback, planExcerpt, agent, { hasMcp }
    );
    fixPlan = result.plan;
  }

  if (!fixPlan || fixPlan.length < 30) {
    logger.error("Child revision plan failed", { childId });
    notifyParent(parentTaskId, repo.name, "Revision planning failed.");
    updateChildStatus(childId, "error");
    return;
  }

  // Implement fix
  updateChildStatus(childId, "implementing");
  let implResult: Awaited<ReturnType<typeof executeImplement>>;
  try {
    implResult = await executeImplement(
      taskProxy, [repo], workDir, fixPlan, agent,
      {
        onEvent,
        hasMcp,
        effectiveWorkDir: sandbox ? `${sandbox.workspaceBase}/${repo.name}` : workDir,
      },
    );
  } finally {
    doneForwarding();
  }

  if (implResult.error) {
    notifyParent(parentTaskId, repo.name, `Revision implementation failed: ${implResult.error}`);
    updateChildStatus(childId, "error");
    return;
  }

  // CI/lint (simplified -- run once, no fix loop for revisions)
  // TODO: could add fix loops here too

  // Tear down sandbox
  if (sandbox) {
    try { await teardownTaskContainer(childId); } catch {}
  }

  // Commit + force push
  try {
    await $`git -C ${workDir} add -A`.quiet();
    const hasChanges = await $`git -C ${workDir} diff --cached --quiet`.quiet().nothrow();
    if (hasChanges.exitCode !== 0) {
      await $`git -C ${workDir} commit -m ${`hoto: revision for ${parentRow.title}`}`.quiet();
    }
  } catch (err) {
    notifyParent(parentTaskId, repo.name, `Revision commit failed: ${err}`);
    updateChildStatus(childId, "error");
    return;
  }

  if (isGiteaConfigured()) {
    try {
      await pushBranchToGitea(workDir, repo.path, repo.name, branchName, true);
      notifyParent(parentTaskId, repo.name, "Revision pushed. Please re-review.");
    } catch (err) {
      notifyParent(parentTaskId, repo.name, `Revision push failed: ${err}`);
      updateChildStatus(childId, "error");
      return;
    }
  }

  // Back to review
  updateChildStatus(childId, "review");

  // Restart review poller
  const prNumber = childRow.pr_number as number | null;
  if (prNumber) {
    await seedCursors(parentTaskId, repo.name, prNumber);
    startReviewPoller(parentTaskId, repo.name, repo.path, branchName, prNumber);
  }
}

export async function restartChildTaskPhase(
  taskId: string,
  childId: string,
  phase: string
): Promise<void> {
  const db = getDb();
  const row = db
    .query("SELECT * FROM child_tasks WHERE id = ? AND parent_task_id = ?")
    .get(childId, taskId) as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError(`Child task not found: ${childId}`);
  const currentState: BlueprintState = row.blueprint_state
    ? JSON.parse(row.blueprint_state as string)
    : createChildInitialState();
  const newState = restartFromPhase(currentState, phase as BlueprintNodeType);
  await killTaskSubprocesses(childId);
  db.run(
    "UPDATE child_tasks SET status = 'running', blueprint_state = ? WHERE id = ?",
    [JSON.stringify(newState), childId]
  );
  runChildTask(childId).catch((err) =>
    logger.error("restartChildTaskPhase: runChildTask failed", { childId, err })
  );
}

/**
 * Check if all children of a parent task are in terminal state.
 * If all committed, mark parent committed.
 */
export function checkParentCompletion(parentTaskId: string): void {
  const db = getDb();

  const children = db.query(
    "SELECT status FROM child_tasks WHERE parent_task_id = ?"
  ).all(parentTaskId) as Array<{ status: string }>;

  if (children.length === 0) return;

  const allTerminal = children.every((c) =>
    ["committed", "error", "cancelled"].includes(c.status)
  );
  if (!allTerminal) return;

  const allCommitted = children.every((c) => c.status === "committed");
  const allCancelled = children.every((c) => c.status === "cancelled");

  const now = new Date().toISOString();

  if (allCommitted) {
    db.run("UPDATE tasks SET status = 'committed', updated_at = ? WHERE id = ?", [now, parentTaskId]);
    logger.info("All child tasks committed, parent task complete", { parentTaskId });
    const manager = getMessagingManager();
    if (manager) {
      manager.notifyAgentOutput(parentTaskId, "All repos committed. Task complete.").catch(() => {});
    }
  } else if (allCancelled) {
    db.run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, parentTaskId]);
    logger.info("All child tasks cancelled, parent task cancelled", { parentTaskId });
  }
  // Mixed state (some committed, some error/cancelled): parent stays waiting_for_children
}
