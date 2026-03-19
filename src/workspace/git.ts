import { $ } from "bun";
import { join } from "path";
import { logger } from "../shared/logger";
import { worktreeDir } from "./manager";

export async function createWorktree(
  repoPath: string,
  taskId: string,
  repoName: string,
  branchName: string
): Promise<string> {
  const wtDir = worktreeDir(taskId, repoName);

  logger.info("Creating git worktree", {
    repo: repoPath,
    worktree: wtDir,
    branch: branchName,
  });

  await $`git -C ${repoPath} worktree add -b ${branchName} ${wtDir}`.quiet();

  return wtDir;
}

export async function removeWorktree(
  repoPath: string,
  wtDir: string
): Promise<void> {
  logger.info("Removing git worktree", { worktree: wtDir });
  await $`git -C ${repoPath} worktree remove ${wtDir} --force`.quiet();
}

export async function getDiff(wtDir: string): Promise<string> {
  const result = await $`git -C ${wtDir} diff HEAD`.text();
  return result;
}

export async function getDiffSummary(
  wtDir: string
): Promise<Array<{ file: string; insertions: number; deletions: number }>> {
  const raw = await $`git -C ${wtDir} diff HEAD --numstat`.text();
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ins, del, file] = line.split("\t");
      return {
        file,
        insertions: parseInt(ins, 10) || 0,
        deletions: parseInt(del, 10) || 0,
      };
    });
}

export async function commitAndPush(
  wtDir: string,
  message: string,
  branchName: string
): Promise<void> {
  await $`git -C ${wtDir} add -A`.quiet();
  await $`git -C ${wtDir} commit -m ${message}`.quiet();
  await $`git -C ${wtDir} push origin ${branchName}`.quiet();
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const result =
      await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.text();
    return result.trim().replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export function generateBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `hoto/${slug}-${taskId.slice(-6)}`;
}
