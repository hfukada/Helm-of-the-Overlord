import type { Repo } from "../../../shared/types";
import { logger } from "../../../shared/logger";

export interface LintResult {
  success: boolean;
  output: string;
  command: string;
}

export async function executeLint(
  repo: Repo,
  workDir: string,
  containerName?: string,
  onChunk?: (accumulated: string) => void
): Promise<LintResult> {
  const cmd = repo.lint_cmd;
  if (!cmd) {
    logger.info("No lint command configured, skipping", { repo: repo.name });
    return { success: true, output: "No lint command configured", command: "" };
  }

  logger.info("Running lint", { repo: repo.name, cmd, workDir, containerName });

  try {
    const argv = containerName
      ? ["docker", "exec", "-w", "/workspace", containerName, "sh", "-c", cmd]
      : ["sh", "-c", cmd];

    const proc = Bun.spawn(argv, {
      cwd: containerName ? undefined : workDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let output = "";
    const decoder = new TextDecoder();

    const readStream = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        onChunk?.(output);
      }
    };

    await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
    await proc.exited;

    if (proc.exitCode === 0) {
      logger.info("Lint passed", { repo: repo.name });
      return { success: true, output, command: cmd };
    }

    logger.warn("Lint failed", { repo: repo.name, exitCode: proc.exitCode });
    return { success: false, output, command: cmd };
  } catch (err) {
    const error = String(err);
    logger.error("Lint execution error", { repo: repo.name, error });
    return { success: false, output: error, command: cmd };
  }
}
