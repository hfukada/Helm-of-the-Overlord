import { $ } from "bun";
import { existsSync } from "fs";
import { logger } from "../../../shared/logger";
import type { Repo } from "../../../shared/types";

export interface DockerComposeResult {
  success: boolean;
  output: string;
}

export async function dockerComposeUp(repo: Repo): Promise<DockerComposeResult> {
  const composePath = repo.docker_compose_path;
  if (!composePath || !existsSync(composePath)) {
    return { success: true, output: "No docker-compose file configured" };
  }

  logger.info("Starting docker-compose services", { path: composePath });

  try {
    const result = await $`docker compose -f ${composePath} up -d`.quiet().nothrow();
    const output = result.stdout.toString() + result.stderr.toString();

    if (result.exitCode === 0) {
      logger.info("Docker compose services started");
      return { success: true, output };
    }

    logger.warn("Docker compose up failed", { exitCode: result.exitCode });
    return { success: false, output };
  } catch (err) {
    return { success: false, output: String(err) };
  }
}

export async function dockerComposeDown(repo: Repo): Promise<DockerComposeResult> {
  const composePath = repo.docker_compose_path;
  if (!composePath || !existsSync(composePath)) {
    return { success: true, output: "No docker-compose file configured" };
  }

  logger.info("Stopping docker-compose services", { path: composePath });

  try {
    const result = await $`docker compose -f ${composePath} down`.quiet().nothrow();
    const output = result.stdout.toString() + result.stderr.toString();
    return { success: result.exitCode === 0, output };
  } catch (err) {
    return { success: false, output: String(err) };
  }
}

export async function dockerComposeStatus(repo: Repo): Promise<string> {
  const composePath = repo.docker_compose_path;
  if (!composePath || !existsSync(composePath)) {
    return "No docker-compose file configured";
  }

  try {
    return await $`docker compose -f ${composePath} ps`.text();
  } catch {
    return "Failed to get docker-compose status";
  }
}
