import { $ } from "bun";
import { existsSync } from "fs";
import { logger } from "../shared/logger";

export async function dockerComposeUp(composePath: string): Promise<{ success: boolean; output: string }> {
  if (!existsSync(composePath)) {
    return { success: false, output: `Compose file not found: ${composePath}` };
  }

  logger.info("Starting docker-compose services", { path: composePath });
  try {
    const result = await $`docker compose -f ${composePath} up -d`.quiet().nothrow();
    const output = result.stdout.toString() + result.stderr.toString();
    return { success: result.exitCode === 0, output };
  } catch (err) {
    return { success: false, output: String(err) };
  }
}

export async function dockerComposeDown(composePath: string): Promise<void> {
  if (!existsSync(composePath)) return;
  logger.info("Stopping docker-compose services", { path: composePath });
  await $`docker compose -f ${composePath} down`.quiet().nothrow();
}
