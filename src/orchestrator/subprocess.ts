/**
 * Subprocess utilities for task-scoped MCP configuration.
 *
 * Agent invocation lives in `src/agent/`. This file remains for orchestrator
 * setup that isn't agent-specific -- currently just `generateMcpConfig`.
 */

import { join, resolve } from "node:path";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import { taskDir } from "../workspace/manager";

/**
 * Generate an MCP config JSON file scoped to a task + repo.
 * - Sandboxed: uses SSE transport via host.docker.internal so containerized
 *   Claude can reach the host-bound MCP server.
 * - Host: uses stdio transport, running `bun run mcp/server.ts` directly.
 */
export async function generateMcpConfig(
  taskId: string,
  workDir: string,
  repoName: string,
  opts?: { sandboxed?: boolean; containerWorkDir?: string }
): Promise<string> {
  const configPath = join(taskDir(taskId), "mcp-config.json");

  let mcpConfig: Record<string, unknown>;

  if (opts?.sandboxed) {
    const mcpUrl = `http://host.docker.internal:${config.mcpHttpPort}`;
    mcpConfig = {
      mcpServers: {
        hoto: {
          type: "sse",
          url: `${mcpUrl}/sse?repo=${repoName}&workDir=${encodeURIComponent(opts.containerWorkDir ?? workDir)}`,
        },
      },
    };
  } else {
    const serverScript = resolve(join(import.meta.dir, "../mcp/server.ts"));
    mcpConfig = {
      mcpServers: {
        hoto: {
          command: "bun",
          args: ["run", serverScript],
          env: {
            HOTO_WORK_DIR: workDir,
            HOTO_REPO_NAME: repoName,
            HOTO_DAEMON_URL: `http://127.0.0.1:${config.daemonPort}`,
          },
        },
      },
    };
  }

  await Bun.write(configPath, JSON.stringify(mcpConfig, null, 2));
  logger.info("Generated MCP config", { taskId, configPath, sandboxed: !!opts?.sandboxed });
  return configPath;
}
