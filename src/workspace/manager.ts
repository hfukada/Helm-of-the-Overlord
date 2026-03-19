import { mkdir } from "fs/promises";
import { join } from "path";
import { config } from "../shared/config";
import { logger } from "../shared/logger";

export async function ensureWorkspace(): Promise<void> {
  await mkdir(config.workspaceDir, { recursive: true });
  logger.info("Workspace ready", { dir: config.workspaceDir });
}

export function taskDir(taskId: string): string {
  return join(config.workspaceDir, "tasks", taskId);
}

export async function ensureTaskDir(taskId: string): Promise<string> {
  const dir = taskDir(taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function worktreeDir(taskId: string, repoName: string): string {
  return join(taskDir(taskId), repoName);
}
