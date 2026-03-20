import { $ } from "bun";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { logger } from "../shared/logger";
import type { Repo, ContainerSecret } from "../shared/types";
import { getRepoSecrets } from "../daemon/routes/secrets";
import { discoverSecrets } from "./secret-discovery";

function containerName(taskId: string): string {
  return `hoto-${taskId.slice(-8)}`;
}

/**
 * Build docker run flags for container secrets.
 *
 * env_var secrets:
 *   - host_env: -e KEY (inherits from host environment)
 *   - host_file: -e KEY="$(cat host_path)" (reads value from file)
 *
 * auth_file secrets:
 *   - host_file: -v host_path:container_path:ro (bind mount)
 */
function buildSecretFlags(secrets: ContainerSecret[]): string[] {
  const flags: string[] = [];

  for (const s of secrets) {
    if (s.secret_type === "env_var") {
      if (s.value_source === "host_env") {
        // Pass through from host environment
        const val = process.env[s.key];
        if (val) {
          flags.push("-e", `${s.key}=${val}`);
        } else {
          logger.warn("Host env var not set, skipping", { key: s.key });
        }
      } else if (s.value_source === "host_file" && s.host_path) {
        // Read value from host file
        try {
          const val = readFileSync(s.host_path, "utf-8").trim();
          flags.push("-e", `${s.key}=${val}`);
        } catch {
          logger.warn("Could not read secret file, skipping", { key: s.key, path: s.host_path });
        }
      }
    } else if (s.secret_type === "auth_file" && s.host_path) {
      const target = s.container_path ?? s.host_path;
      if (existsSync(s.host_path)) {
        flags.push("-v", `${s.host_path}:${target}:ro`);
      } else {
        logger.warn("Auth file not found on host, skipping", { key: s.key, path: s.host_path });
      }
    }
  }

  return flags;
}

export async function setupTaskContainer(
  repo: Repo,
  workDir: string,
  taskId: string
): Promise<string | null> {
  const name = containerName(taskId);

  // Look up verified secrets for this repo
  const secrets = getRepoSecrets(repo.id);
  if (secrets.length > 0) {
    logger.info("Mounting container secrets", {
      taskId,
      count: secrets.length,
      keys: secrets.map((s) => s.key),
    });
  }

  // Option 1: docker-compose
  if (repo.docker_compose_path) {
    const composePath = join(repo.path, repo.docker_compose_path);
    if (!existsSync(composePath)) {
      logger.warn("Docker compose file not found", { path: composePath });
      return null;
    }

    // For compose, pass secrets as environment variables
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const s of secrets) {
      if (s.secret_type === "env_var") {
        if (s.value_source === "host_env" && process.env[s.key]) {
          env[s.key] = process.env[s.key]!;
        } else if (s.value_source === "host_file" && s.host_path) {
          try {
            env[s.key] = readFileSync(s.host_path, "utf-8").trim();
          } catch {}
        }
      }
    }

    logger.info("Starting docker-compose for task", { taskId, composePath });
    const result = await $`docker compose -f ${composePath} up -d`.env(env).quiet().nothrow();
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
    const buildOutput = buildResult.stderr.toString();
    logger.warn("Docker build failed", { taskId, output: buildOutput });
    discoverSecrets(repo.id, buildOutput);
    return null;
  }

  const secretFlags = buildSecretFlags(secrets);

  logger.info("Starting Docker container for task", { taskId, name });
  const args = [
    "docker", "run", "-d",
    "--name", name,
    "-v", `${workDir}:/workspace`,
    "-w", "/workspace",
    ...secretFlags,
    imageName,
    "sleep", "infinity",
  ];
  const runResult = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (runResult.exitCode !== 0) {
    logger.warn("Docker run failed", {
      taskId,
      output: new TextDecoder().decode(runResult.stderr),
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
