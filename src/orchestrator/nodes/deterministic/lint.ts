import { $ } from "bun";
import type { Repo } from "../../../shared/types";
import { logger } from "../../../shared/logger";

export interface LintResult {
  success: boolean;
  output: string;
  command: string;
}

export async function executeLint(repo: Repo, workDir: string): Promise<LintResult> {
  const cmd = repo.lint_cmd;
  if (!cmd) {
    logger.info("No lint command configured, skipping", { repo: repo.name });
    return { success: true, output: "No lint command configured", command: "" };
  }

  logger.info("Running lint", { repo: repo.name, cmd, workDir });

  try {
    const result = await $`sh -c ${cmd}`.cwd(workDir).quiet().nothrow();
    const output = result.stdout.toString() + result.stderr.toString();

    if (result.exitCode === 0) {
      logger.info("Lint passed", { repo: repo.name });
      return { success: true, output, command: cmd };
    }

    logger.warn("Lint failed", { repo: repo.name, exitCode: result.exitCode });
    return { success: false, output, command: cmd };
  } catch (err) {
    const error = String(err);
    logger.error("Lint execution error", { repo: repo.name, error });
    return { success: false, output: error, command: cmd };
  }
}
