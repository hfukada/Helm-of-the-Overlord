import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureProjectDir } from "../workspace/manager";
import { planProject } from "./planner";
import type { Project, ProjectMilestone } from "../shared/types";

function getProject(id: string): Project | null {
  const db = getDb();
  const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    ...(row as unknown as Project),
    milestones: JSON.parse(row.milestones as string),
  };
}

function saveProject(project: Project): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `UPDATE projects SET title=?, description=?, status=?, milestones=?, current_milestone=?, updated_at=? WHERE id=?`,
    [
      project.title,
      project.description,
      project.status,
      JSON.stringify(project.milestones),
      project.current_milestone,
      now,
      project.id,
    ]
  );
}

export async function createProject(
  description: string,
  repoNames: string[],
  sourceSenderId: string | null,
  sourceProvider: string | null
): Promise<{ id: string; title: string }> {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO projects (id, title, description, status, milestones, current_milestone, repo_id, source_sender_id, source_provider, created_at, updated_at)
     VALUES (?, ?, ?, 'planning', '[]', 0, NULL, ?, ?, ?, ?)`,
    [id, "Planning\u2026", description, sourceSenderId, sourceProvider, now, now]
  );

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
    project.status = "in_progress";
    saveProject(project);

    await advanceProject(id);
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
        description: `[Project: ${project.title} \u2014 Milestone ${milestone.index + 1}/${project.milestones.length}]\n\n${milestone.description}`,
        source_sender_id: project.source_sender_id,
        source_provider: project.source_provider,
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
    };
    const milestone = project.milestones[project.current_milestone];
    if (milestone?.task_id !== taskId) continue;

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
    } else {
      saveProject(project);
      await advanceProject(project.id);
    }
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
