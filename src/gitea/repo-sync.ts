import { ensureGiteaRepo, getGiteaRemoteUrl } from "./client";
import { addRemote, pushToRemote, getDefaultBranch } from "../workspace/git";
import { logger } from "../shared/logger";
import { $ } from "bun";

const GITEA_REMOTE = "gitea";

export async function ensureRepoOnGitea(repoPath: string, repoName: string): Promise<void> {
  await ensureGiteaRepo(repoName);

  const remoteUrl = getGiteaRemoteUrl(repoName);
  await addRemote(repoPath, GITEA_REMOTE, remoteUrl);

  // Push the default branch so PRs have a base
  const defaultBranch = await getDefaultBranch(repoPath);
  try {
    await $`git -C ${repoPath} push ${GITEA_REMOTE} ${defaultBranch}`.quiet();
    logger.info("Pushed default branch to Gitea", { repoName, branch: defaultBranch });
  } catch (err) {
    // May fail if already up to date, that's fine
    logger.debug?.("Default branch push result", { repoName, error: String(err) });
  }
}

export async function pushBranchToGitea(
  workDir: string,
  repoPath: string,
  repoName: string,
  branchName: string,
  force?: boolean
): Promise<void> {
  // Ensure the gitea remote exists on the worktree too
  const remoteUrl = getGiteaRemoteUrl(repoName);
  await addRemote(workDir, GITEA_REMOTE, remoteUrl);

  // Commit any uncommitted changes first
  try {
    await $`git -C ${workDir} add -A`.quiet();
    await $`git -C ${workDir} diff --cached --quiet`.quiet();
  } catch {
    // There are staged changes, commit them
    await $`git -C ${workDir} commit -m "hoto: implementation changes"`.quiet().nothrow();
  }

  await pushToRemote(workDir, branchName, GITEA_REMOTE, force);
  logger.info("Pushed task branch to Gitea", { repoName, branch: branchName, force: !!force });
}
