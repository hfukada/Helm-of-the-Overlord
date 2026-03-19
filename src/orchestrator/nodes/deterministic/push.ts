import { $ } from "bun";
import { logger } from "../../../shared/logger";

export interface PushResult {
  success: boolean;
  output: string;
}

export async function executePush(workDir: string, branchName: string): Promise<PushResult> {
  logger.info("Staging and committing changes", { workDir, branch: branchName });

  try {
    // Stage all changes
    await $`git -C ${workDir} add -A`.quiet();

    // Check if there are changes to commit
    const status = await $`git -C ${workDir} status --porcelain`.text();
    if (!status.trim()) {
      return { success: true, output: "No changes to commit" };
    }

    // Commit
    await $`git -C ${workDir} commit -m ${"hoto: automated implementation"}`.quiet();

    logger.info("Changes committed, pushing", { branch: branchName });

    // Push
    const result = await $`git -C ${workDir} push origin ${branchName}`.quiet().nothrow();
    const output = result.stdout.toString() + result.stderr.toString();

    if (result.exitCode === 0) {
      logger.info("Push succeeded", { branch: branchName });
      return { success: true, output };
    }

    logger.warn("Push failed", { exitCode: result.exitCode, output });
    return { success: false, output };
  } catch (err) {
    const error = String(err);
    logger.error("Push error", { error });
    return { success: false, output: error };
  }
}
