import { join, resolve } from "node:path";
import { ulid } from "ulid";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureProjectDir, projectDir } from "../workspace/manager";
import { planProject } from "./planner";
import { reviseRemainingMilestones } from "./revisor";
import type { Project, ProjectMilestone } from "../shared/types";

function getProject(id: string): Project | null {
  const db = getDb();
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    ...(row as unknown as Project),
    milestones: JSON.parse(row.milestones as string),
    repo_names: JSON.parse((row.repo_names as string) || '[]'),
  };
}

function saveProject(project: Project): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `UPDATE projects SET title=?, description=?, status=?, milestones=?, repo_names=?, current_milestone=?, carry_over_notes=?, updated_at=? WHERE id=?`,
    [
      project.title,
      project.description,
      project.status,
      JSON.stringify(project.milestones),
      JSON.stringify(project.repo_names),
      project.current_milestone,
      project.carry_over_notes ?? null,
      now,
      project.id,
    ]
  );
}

export async function createProject(
  description: string,
  repoNames: string[],
  sourceSenderId: string | null,
  sourceProvider: string | null,
  preAllocatedId?: string,
): Promise<{ id: string; title: string }> {
  const db = getDb();
  const id = preAllocatedId ?? ulid();
  if (!preAllocatedId) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO projects (id, title, description, status, milestones, current_milestone, repo_id, repo_names, source_sender_id, source_provider, created_at, updated_at)
       VALUES (?, ?, ?, 'planning', '[]', 0, NULL, ?, ?, ?, ?, ?)`,
      [id, "Planning…", description, JSON.stringify(repoNames), sourceSenderId, sourceProvider, now, now]
    );
  }

  // Build MCP config in the project directory — never use taskDir for projects
  const pDir = await ensureProjectDir(id);
  const serverScript = resolve(join(import.meta.dir, "../mcp/server.ts"));
  const mcpConfig = {
    mcpServers: {
      hoto: {
        command: "bun",
        args: ["run", serverScript],
        env: {
          HOTO_WORK_DIR: config.workspaceDir,
          HOTO_REPO_NAME: repoNames[0] ?? "",
          HOTO_DAEMON_URL: `http://127.0.0.1:${config.daemonPort}`,
        },
      },
    },
  };
  const mcpConfigPath = join(pDir, "mcp-config.json");
  await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  try {
    const plan = await planProject(description, repoNames, mcpConfigPath);
    const milestones: ProjectMilestone[] = plan.milestones.map((m, i) => ({
      ...m,
      index: i,
      task_id: null,
      completed: false,
    }));

    const project = getProject(id);
    if (!project) throw new Error(`Project ${id} not found after creation`);
    project.title = plan.title;
    project.milestones = milestones;
    project.status = "awaiting_advance";
    saveProject(project);

    return { id, title: plan.title };
  } catch (err) {
    logger.warn("Project planning failed", { projectId: id, error: String(err) });
    getDb().run("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [new Date().toISOString(), id]);
    throw err;
  }
}

export async function advanceProject(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project || project.status !== "in_progress") return;

  const milestone = project.milestones[project.current_milestone];
  if (!milestone) return;

  try {
    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: [
          `[Project: ${project.title} — Milestone ${milestone.index + 1}/${project.milestones.length}]`,
          "",
          milestone.description,
          ...(project.carry_over_notes
            ? ["", "Carry-over notes from previous milestone:", project.carry_over_notes]
            : []),
        ].join("\n"),
        source_sender_id: project.source_sender_id,
        source_provider: project.source_provider,
        repo_names: project.repo_names,
        project_id: projectId,
      }),
    });

    if (!res.ok) throw new Error(`Task creation failed: ${res.status}`);
    const { id: taskId } = (await res.json()) as { id: string };

    project.milestones[project.current_milestone].task_id = taskId;
    saveProject(project);
    logger.info("Project milestone task created", { projectId, milestoneIndex: milestone.index, taskId });
  } catch (err) {
    logger.warn("advanceProject failed — will retry on next restart", {
      projectId,
      milestoneIndex: project.current_milestone,
      error: String(err),
    });
    // Leave task_id null; resumeProjects will retry
  }
}

export async function onTaskCompleted(taskId: string): Promise<void> {
  const db = getDb();
  // Find an in_progress project whose current milestone references this taskId
  const rows = db
    .query("SELECT * FROM projects WHERE status = 'in_progress'")
    .all() as Record<string, unknown>[];

  for (const row of rows) {
    const project: Project = {
      ...(row as unknown as Project),
      milestones: JSON.parse(row.milestones as string),
      repo_names: JSON.parse((row.repo_names as string) || '[]'),
    };
    const milestone = project.milestones[project.current_milestone];
    if (milestone?.task_id !== taskId) continue;

    // Capture carry-over notes from the completed task's latest agent run
    const latestRun = db
      .query(
        "SELECT output FROM agent_runs WHERE task_id = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1"
      )
      .get(taskId) as { output: string | null } | null;
    if (latestRun?.output) {
      project.carry_over_notes = latestRun.output.slice(0, 2000);
    } else {
      project.carry_over_notes = null;
    }

    const completedIndex = project.current_milestone;
    milestone.completed = true;
    project.current_milestone += 1;

    if (project.current_milestone >= project.milestones.length) {
      project.status = "completed";
      saveProject(project);
      logger.info("Project completed", { projectId: project.id });

      // Notify via messaging manager — best-effort
      try {
        const { getMessagingManager } = await import("../messaging/manager");
        const manager = getMessagingManager();
        if (manager && project.source_sender_id && project.source_provider) {
          const provider = (manager as unknown as { providers: Map<string, { sendMessage: (channelId: string, message: string) => Promise<void>; getMainChannelId: () => string | null }> }).providers.get(project.source_provider);
          const mainChannelId = provider?.getMainChannelId();
          if (provider && mainChannelId) {
            await provider.sendMessage(mainChannelId, `Project complete: ${project.title}`);
          }
        }
      } catch {
        // Notification is best-effort
      }
      return;
    }

    // Revision step: between milestones, ask an agent whether the remaining
    // plan still makes sense given feedback from the completed task. Failures
    // here must not block project advancement.
    project.status = "revising";
    saveProject(project);
    try {
      const mcpConfigPath = join(projectDir(project.id), "mcp-config.json");
      const revision = await reviseRemainingMilestones(project, taskId, completedIndex, mcpConfigPath);
      if (revision?.changed) {
        const completedMilestones = project.milestones.slice(0, completedIndex + 1);
        project.milestones = [...completedMilestones, ...revision.remainingMilestones];
        const note = `Revisor adjusted ${revision.remainingMilestones.length} remaining milestone(s). Reason: ${revision.rationale}`;
        project.carry_over_notes = project.carry_over_notes
          ? `${project.carry_over_notes}\n\n${note}`
          : note;
        logger.info("Project plan revised", {
          projectId: project.id,
          completedIndex,
          newRemaining: revision.remainingMilestones.length,
          rationale: revision.rationale,
        });
      } else if (revision) {
        logger.info("Project plan unchanged after revision", {
          projectId: project.id,
          completedIndex,
          rationale: revision.rationale,
        });
      }
    } catch (err) {
      logger.warn("Revision step threw; continuing without changes", {
        projectId: project.id,
        completedIndex,
        error: String(err),
      });
    }

    // Re-read the project in case the user cancelled or otherwise mutated it
    // while the revisor was running.
    const refreshed = getProject(project.id);
    if (!refreshed || refreshed.status === "cancelled" || refreshed.status === "failed") {
      logger.info("Project no longer in_progress after revision; not advancing", {
        projectId: project.id,
        status: refreshed?.status,
      });
      return;
    }

    project.status = "awaiting_advance";
    saveProject(project);
    return;
  }
}

export async function resumeProjects(): Promise<void> {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM projects WHERE status = 'in_progress'")
    .all() as Record<string, unknown>[];

  for (const row of rows) {
    const project: Project = {
      ...(row as unknown as Project),
      milestones: JSON.parse(row.milestones as string),
    };
    const milestone = project.milestones[project.current_milestone];
    if (!milestone) continue;

    if (!milestone.task_id) {
      // Planning was interrupted before the task was created — retry
      logger.info("resumeProjects: retrying task creation for milestone", {
        projectId: project.id,
        milestoneIndex: project.current_milestone,
      });
      await advanceProject(project.id);
      continue;
    }

    // Check if the task is already committed (terminal state)
    const task = db
      .query("SELECT status FROM tasks WHERE id = ?")
      .get(milestone.task_id) as { status: string } | null;

    if (task?.status === "committed") {
      logger.info("resumeProjects: task already committed, advancing project", {
        projectId: project.id,
        taskId: milestone.task_id,
      });
      await onTaskCompleted(milestone.task_id);
    }
    // If task is live (any other non-terminal status), no-op — it will fire onTaskCompleted when done
  }
}
