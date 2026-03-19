import { $ } from "bun";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../shared/logger";
import type { Repo } from "../shared/types";

function containerName(taskId: string): string {
  return `hoto-${taskId.slice(-8)}`;
}

export async function setupTaskContainer(
  repo: Repo,
  workDir: string,
  taskId: string
): Promise<string | null> {
  const name = containerName(taskId);

  // Option 1: docker-compose
  if (repo.docker_compose_path) {
    const composePath = join(repo.path, repo.docker_compose_path);
    if (!existsSync(composePath)) {
      logger.warn("Docker compose file not found", { path: composePath });
      return null;
    }

    logger.info("Starting docker-compose for task", { taskId, composePath });
    const result = await $`docker compose -f ${composePath} up -d`.quiet().nothrow();
    if (result.exitCode !== 0) {
      logger.warn("Docker compose up failed", {
        taskId,
        output: result.stderr.toString(),
      });
      return null;
    }

    // Get the first running service container name
    try {
      const ps = await $`docker compose -f ${composePath} ps --format json`.quiet().text();
      const lines = ps.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const first = JSON.parse(lines[0]) as { Name?: string };
        if (first.Name) {
          logger.info("Docker compose container identified", { taskId, container: first.Name });
          return first.Name;
        }
      }
    } catch (err) {
      logger.warn("Could not identify compose container", { error: String(err) });
    }

    return null;
  }

  // Option 2: Dockerfile in workdir
  const dockerfile = join(workDir, "Dockerfile");
  if (!existsSync(dockerfile)) {
    return null;
  }

  const imageName = `hoto-img-${taskId.slice(-8)}`;
  logger.info("Building Docker image for task", { taskId, workDir });

  const buildResult = await $`docker build -t ${imageName} ${workDir}`.quiet().nothrow();
  if (buildResult.exitCode !== 0) {
    logger.warn("Docker build failed", {
      taskId,
      output: buildResult.stderr.toString(),
    });
    return null;
  }

  logger.info("Starting Docker container for task", { taskId, name });
  const runResult = await $`docker run -d --name ${name} -v ${workDir}:/workspace -w /workspace ${imageName} sleep infinity`.quiet().nothrow();
  if (runResult.exitCode !== 0) {
    logger.warn("Docker run failed", {
      taskId,
      output: runResult.stderr.toString(),
    });
    return null;
  }

  logger.info("Docker container started", { taskId, name });
  return name;
}

export async function teardownTaskContainer(taskId: string): Promise<void> {
  const name = containerName(taskId);
  logger.info("Tearing down Docker container", { taskId, name });

  await $`docker stop ${name}`.quiet().nothrow();
  await $`docker rm -f ${name}`.quiet().nothrow();

  // Clean up image if we built one
  const imageName = `hoto-img-${taskId.slice(-8)}`;
  await $`docker rmi ${imageName}`.quiet().nothrow();
}
