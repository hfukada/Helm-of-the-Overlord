import { $ } from "bun";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Track which container names were started as sandbox containers so callers
 * can determine the correct workDir inside the container.
 */
const sandboxContainerNames = new Set<string>();

export function isSandboxContainer(name: string): boolean {
  return sandboxContainerNames.has(name);
}

async function sandboxImageExists(): Promise<boolean> {
  const result = Bun.spawnSync(["docker", "image", "inspect", "hoto-sandbox:latest"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0;
}

async function buildSandboxImage(dockerfilePath: string): Promise<boolean> {
  const contextDir = join(dockerfilePath, "..");
  logger.info({ dockerfilePath }, "building sandbox image");
  const result = Bun.spawnSync(
    ["docker", "build", "-t", "hoto-sandbox:latest", "-f", dockerfilePath, contextDir],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0) {
    logger.error({ stderr: new TextDecoder().decode(result.stderr) }, "failed to build sandbox image");
    return false;
  }
  return true;
}

export async function startSandboxContainer(
  taskId: string,
  taskDirectory: string,
): Promise<string | null> {
  // Resolve Dockerfile.sandbox two levels up from src/workspace/ to the repo root
  const dockerfilePath = join(import.meta.dir, "../../Dockerfile.sandbox");

  const imageReady = (await sandboxImageExists()) || (await buildSandboxImage(dockerfilePath));
  if (!imageReady) {
    logger.error({ taskId }, "sandbox image not available; cannot start sandbox container");
    return null;
  }

  const credentialsPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credentialsPath)) {
    logger.error(
      { taskId },
      "claude credentials not found at ~/.claude/.credentials.json -- sandbox container will not have claude access"
    );
    return null;
  }

  const name = containerName(taskId);

  const args = [
    "docker", "run", "-d",
    "--name", name,
    "-v", `${taskDirectory}:/workspace`,
    "-w", "/workspace",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${credentialsPath}:/root/.claude/.credentials.json:ro`,
    "hoto-sandbox:latest",
    "sleep", "infinity",
  ];

  const runResult = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (runResult.exitCode !== 0) {
    logger.error({
      taskId,
      stderr: new TextDecoder().decode(runResult.stderr),
    }, "failed to start sandbox container");
    return null;
  }

  sandboxContainerNames.add(name);
  logger.info({ taskId, name, taskDirectory }, "sandbox container started");
  return name;
}

export async function setupTaskContainer(
  repo: Repo,
  workDir: string,
  taskId: string,
  taskDirectory: string,
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
          env[s.key] = process.env[s.key] ?? "";
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
  if (existsSync(dockerfile)) {
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

  // Option 3: Language-based Docker image fallback
  if (repo.docker_image) {
    const secretFlags = buildSecretFlags(secrets);

    logger.info("Starting language-based Docker container", {
      taskId,
      image: repo.docker_image,
      name,
    });

    const args = [
      "docker", "run", "-d",
      "--name", name,
      "-v", `${workDir}:/workspace`,
      "-w", "/workspace",
      ...secretFlags,
      repo.docker_image,
      "sleep", "infinity",
    ];
    const runResult = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (runResult.exitCode !== 0) {
      logger.warn("Docker run (language image) failed", {
        taskId,
        image: repo.docker_image,
        output: new TextDecoder().decode(runResult.stderr),
      });
      return null;
    }

    logger.info("Language-based Docker container started", { taskId, name, image: repo.docker_image });
    return name;
  }

  // No repo-specific container config found; fall back to sandbox
  logger.info({ taskId, taskDirectory }, "no repo-specific container config found; falling back to sandbox");
  return startSandboxContainer(taskId, taskDirectory);
}

export async function teardownTaskContainer(taskId: string): Promise<void> {
  const name = containerName(taskId);
  logger.info("Tearing down Docker container", { taskId, name });

  await $`docker stop ${name}`.quiet().nothrow();
  await $`docker rm -f ${name}`.quiet().nothrow();

  // Clean up per-task image if we built one.
  // Per-task images follow the pattern hoto-img-<suffix>; the shared sandbox image
  // is hoto-sandbox:latest and should NOT be removed here (no-op guard for safety).
  const imageName = `hoto-img-${taskId.slice(-8)}`;
  if (imageName !== "hoto-sandbox:latest") {
    await $`docker rmi ${imageName}`.quiet().nothrow();
  }
}
