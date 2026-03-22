import { $ } from "bun";
import { logger } from "../shared/logger";
import { worktreeDir } from "./manager";

/**
 * Clone the repo into the task work directory and create the task branch.
 * Uses a clean clone instead of a worktree so the task is fully isolated.
 */
export async function createTaskClone(
  repoPath: string,
  taskId: string,
  repoName: string,
  branchName: string
): Promise<string> {
  const destDir = worktreeDir(taskId, repoName);

  // Try to get the remote URL so we clone from the actual remote
  let cloneSource = repoPath;
  try {
    const remoteUrl = (
      await $`git -C ${repoPath} remote get-url origin`.text()
    ).trim();
    if (remoteUrl) cloneSource = remoteUrl;
  } catch {
    // No remote configured -- fall back to cloning the local path
  }

  const defaultBranch = await getDefaultBranch(repoPath);

  logger.info("Cloning repository for task", {
    source: cloneSource,
    dest: destDir,
    branch: defaultBranch,
    taskBranch: branchName,
  });

  await $`git clone --branch ${defaultBranch} ${cloneSource} ${destDir}`.quiet();

  // Create the task branch in the clone
  await $`git -C ${destDir} checkout -b ${branchName}`.quiet();

  return destDir;
}

/**
 * Remove a task's cloned directory.
 */
export async function removeTaskClone(cloneDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(cloneDir, { recursive: true, force: true });
  logger.info("Removed task clone", { dir: cloneDir });
}

/**
 * Find the base ref to diff against.
 */
async function getBaseRef(workDir: string): Promise<string | null> {
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const ref = await $`git -C ${workDir} merge-base HEAD ${base}`.text();
      if (ref.trim()) return ref.trim();
    } catch {}
  }
  try {
    const branch = (await $`git -C ${workDir} rev-parse --abbrev-ref HEAD`.text()).trim();
    const unique = (await $`git -C ${workDir} log ${branch} --not --remotes --format=%H`.nothrow().text()).trim();
    if (unique) {
      const firstUnique = unique.split("\n").pop();
      if (firstUnique) {
        const parent = (await $`git -C ${workDir} rev-parse ${firstUnique}~1`.text()).trim();
        if (parent) return parent;
      }
    }
  } catch {}
  return null;
}

export async function getDiff(workDir: string): Promise<string> {
  const base = await getBaseRef(workDir);
  const parts: string[] = [];

  if (base) {
    const committed = await $`git -C ${workDir} diff ${base}..HEAD`.text();
    if (committed.trim()) parts.push(committed);
  }

  const staged = await $`git -C ${workDir} diff --cached`.text();
  if (staged.trim()) parts.push(staged);

  const unstaged = await $`git -C ${workDir} diff`.text();
  if (unstaged.trim()) parts.push(unstaged);

  const untracked = (await $`git -C ${workDir} ls-files --others --exclude-standard`.text()).trim();
  if (untracked) {
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        const content = await $`git diff --no-index /dev/null ${file}`.cwd(workDir).nothrow().text();
        if (content.trim()) parts.push(content);
      } catch {}
    }
  }

  return parts.join("\n");
}

export async function getDiffSummary(
  workDir: string
): Promise<Array<{ file: string; insertions: number; deletions: number }>> {
  const base = await getBaseRef(workDir);
  const fileMap = new Map<string, { insertions: number; deletions: number }>();

  const addNumstat = (raw: string) => {
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      const [ins, del, file] = line.split("\t");
      if (!file) continue;
      const existing = fileMap.get(file) ?? { insertions: 0, deletions: 0 };
      existing.insertions += parseInt(ins, 10) || 0;
      existing.deletions += parseInt(del, 10) || 0;
      fileMap.set(file, existing);
    }
  };

  if (base) {
    addNumstat(await $`git -C ${workDir} diff ${base}..HEAD --numstat`.text());
  }
  addNumstat(await $`git -C ${workDir} diff --cached --numstat`.text());
  addNumstat(await $`git -C ${workDir} diff --numstat`.text());
  const untracked = (await $`git -C ${workDir} ls-files --others --exclude-standard`.text()).trim();
  if (untracked) {
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        const stat = await $`git diff --no-index --numstat /dev/null ${file}`.cwd(workDir).nothrow().text();
        addNumstat(stat);
      } catch {}
    }
  }

  return Array.from(fileMap.entries()).map(([file, stats]) => ({
    file,
    ...stats,
  }));
}

export async function commitAndPush(
  workDir: string,
  message: string,
  branchName: string
): Promise<void> {
  await $`git -C ${workDir} add -A`.quiet();
  await $`git -C ${workDir} commit -m ${message}`.quiet();
  await $`git -C ${workDir} push origin ${branchName}`.quiet();
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

export async function addRemote(repoPath: string, name: string, url: string): Promise<void> {
  try {
    await $`git -C ${repoPath} remote add ${name} ${url}`.quiet();
  } catch {
    await $`git -C ${repoPath} remote set-url ${name} ${url}`.quiet();
  }
}

export async function pushToRemote(
  workDir: string,
  branchName: string,
  remoteName: string,
  force?: boolean
): Promise<void> {
  if (force) {
    await $`git -C ${workDir} push --force ${remoteName} ${branchName}`.quiet();
  } else {
    await $`git -C ${workDir} push ${remoteName} ${branchName}`.quiet();
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
