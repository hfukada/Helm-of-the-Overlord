import { $ } from "bun";
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

/**
 * Find the base ref to diff against -- the commit the branch was created from.
 * The worktree branch is created off the repo's default branch via
 * `git worktree add -b <branch>`, so the branch point IS the current HEAD
 * of the default branch. We find it via merge-base.
 */
async function getBaseRef(wtDir: string): Promise<string | null> {
  // Try merge-base with common default branches
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const ref = await $`git -C ${wtDir} merge-base HEAD ${base}`.text();
      if (ref.trim()) return ref.trim();
    } catch {}
  }
  // Fall back: the parent of the first unique commit on this branch
  try {
    // Get the branch name
    const branch = (await $`git -C ${wtDir} rev-parse --abbrev-ref HEAD`.text()).trim();
    // Find commits unique to this branch (not on any other branch)
    const unique = (await $`git -C ${wtDir} log ${branch} --not --remotes --format=%H`.nothrow().text()).trim();
    if (unique) {
      const firstUnique = unique.split("\n").pop();
      if (firstUnique) {
        const parent = (await $`git -C ${wtDir} rev-parse ${firstUnique}~1`.text()).trim();
        if (parent) return parent;
      }
    }
  } catch {}
  return null;
}

/**
 * Get the full diff for a worktree, including:
 * - Committed changes (on the branch but not on the base)
 * - Staged but uncommitted changes
 * - Unstaged changes to tracked files
 * - Newly created (untracked) files
 */
export async function getDiff(wtDir: string): Promise<string> {
  const base = await getBaseRef(wtDir);
  const parts: string[] = [];

  // 1. Committed changes relative to base branch
  if (base) {
    const committed = await $`git -C ${wtDir} diff ${base}..HEAD`.text();
    if (committed.trim()) parts.push(committed);
  }

  // 2. Staged changes (index vs HEAD)
  const staged = await $`git -C ${wtDir} diff --cached`.text();
  if (staged.trim()) parts.push(staged);

  // 3. Unstaged changes to tracked files (working tree vs index)
  const unstaged = await $`git -C ${wtDir} diff`.text();
  if (unstaged.trim()) parts.push(unstaged);

  // 4. Untracked files -- show as new file diffs
  const untracked = (await $`git -C ${wtDir} ls-files --others --exclude-standard`.text()).trim();
  if (untracked) {
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        const content = await $`git diff --no-index /dev/null ${file}`.cwd(wtDir).nothrow().text();
        if (content.trim()) parts.push(content);
      } catch {}
    }
  }

  return parts.join("\n");
}

export async function getDiffSummary(
  wtDir: string
): Promise<Array<{ file: string; insertions: number; deletions: number }>> {
  const base = await getBaseRef(wtDir);
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

  // Committed changes
  if (base) {
    addNumstat(await $`git -C ${wtDir} diff ${base}..HEAD --numstat`.text());
  }
  // Staged changes
  addNumstat(await $`git -C ${wtDir} diff --cached --numstat`.text());
  // Unstaged changes
  addNumstat(await $`git -C ${wtDir} diff --numstat`.text());
  // Untracked files
  const untracked = (await $`git -C ${wtDir} ls-files --others --exclude-standard`.text()).trim();
  if (untracked) {
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        const stat = await $`git diff --no-index --numstat /dev/null ${file}`.cwd(wtDir).nothrow().text();
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
  wtDir: string,
  message: string,
  branchName: string
): Promise<void> {
  await $`git -C ${wtDir} add -A`.quiet();
  await $`git -C ${wtDir} commit -m ${message}`.quiet();
  await $`git -C ${wtDir} push origin ${branchName}`.quiet();
}

/**
 * Clone the repository's remote origin (or local path as fallback) into the
 * task work directory and create the task branch in the clone.
 *
 * Returns the path to the cloned directory (same layout as worktreeDir so the
 * rest of the pipeline is transparent to which mode was used).
 */
export async function cloneRepoCopy(
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

  logger.info("Cloning repository for full-copy task", {
    source: cloneSource,
    dest: destDir,
    branch: defaultBranch,
  });

  await $`git clone --branch ${defaultBranch} ${cloneSource} ${destDir}`.quiet();

  // Create the task branch in the clone
  await $`git -C ${destDir} checkout -b ${branchName}`.quiet();

  logger.info("Full-copy clone ready", { destDir, taskBranch: branchName });
  return destDir;
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
    // Remote may already exist -- update the URL
    await $`git -C ${repoPath} remote set-url ${name} ${url}`.quiet();
  }
}

export async function pushToRemote(
  wtDir: string,
  branchName: string,
  remoteName: string,
  force?: boolean
): Promise<void> {
  if (force) {
    await $`git -C ${wtDir} push --force ${remoteName} ${branchName}`.quiet();
  } else {
    await $`git -C ${wtDir} push ${remoteName} ${branchName}`.quiet();
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
