import { $ } from "bun";
import { logger } from "../../../shared/logger";

export async function getChangedFiles(workDir: string): Promise<string[]> {
  const result = await $`git -C ${workDir} diff --name-only HEAD`.text();
  return result.trim().split("\n").filter(Boolean);
}

export async function getStagedFiles(workDir: string): Promise<string[]> {
  const result = await $`git -C ${workDir} diff --cached --name-only`.text();
  return result.trim().split("\n").filter(Boolean);
}

export async function getStatus(workDir: string): Promise<string> {
  return await $`git -C ${workDir} status --short`.text();
}

export async function stageAll(workDir: string): Promise<void> {
  await $`git -C ${workDir} add -A`.quiet();
}

export async function commitChanges(
  workDir: string,
  message: string
): Promise<boolean> {
  try {
    await $`git -C ${workDir} add -A`.quiet();
    const status = await $`git -C ${workDir} status --porcelain`.text();
    if (!status.trim()) {
      logger.info("No changes to commit");
      return false;
    }
    await $`git -C ${workDir} commit -m ${message}`.quiet();
    return true;
  } catch (err) {
    logger.error("Commit failed", { error: String(err) });
    return false;
  }
}

export async function getLog(
  workDir: string,
  count: number = 5
): Promise<string> {
  return await $`git -C ${workDir} log --oneline -${count}`.text();
}
