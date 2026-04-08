
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { logger } from "../shared/logger";
import type { TokenUsage, StreamEventType } from "../shared/types";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";
import { claudeStream, type ClaudeEvent } from "../shared/claude-cli";
import { taskDir } from "../workspace/manager";

export interface SubprocessOptions {
  prompt: string;
  systemPrompt?: string;
  workDir: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  mcpConfigPath?: string;
  addDirs?: string[];
  agentRunId: string;
  taskId?: string;
  onEvent?: (eventType: StreamEventType, content: string) => void;
  /** If set, run claude inside this Docker container. */
  containerName?: string;
  /** Working directory inside the container. */
  containerWorkDir?: string;
}

export interface SubprocessResult {
  output: string;
  usage: TokenUsage;
  error: string | null;
}

function storeStreamEvent(
  agentRunId: string,
  eventType: StreamEventType,
  content: unknown
): void {
  const safeContent = typeof content === "string"
    ? content
    : content == null
      ? ""
      : JSON.stringify(content);
  const db = getDb();
  db.run(
    "INSERT INTO agent_stream (agent_run_id, event_type, content) VALUES (?, ?, ?)",
    [agentRunId, eventType, safeContent]
  );
}

export async function runClaude(opts: SubprocessOptions): Promise<SubprocessResult> {
  const model = opts.model ?? config.defaultModel;

  logger.info("Spawning claude subprocess", {
    model,
    workDir: opts.workDir,
    agentRunId: opts.agentRunId,
  });

  // Dump prompt to task directory for debugging
  if (opts.taskId) {
    try {
      const nodeName = (getDb().query(
        "SELECT node_name FROM agent_runs WHERE id = ?"
      ).get(opts.agentRunId) as { node_name: string } | null)?.node_name ?? "unknown";

      const promptsDir = join(taskDir(opts.taskId), "prompts");
      mkdirSync(promptsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${timestamp}_${nodeName}.md`;
      const content = [
        `# ${nodeName}`,
        `Agent Run: ${opts.agentRunId}`,
        `Model: ${model}`,
        `Timestamp: ${new Date().toISOString()}`,
        "",
        "## System Prompt",
        opts.systemPrompt ?? "(none)",
        "",
        "## Prompt",
        opts.prompt,
      ].join("\n");

      writeFileSync(join(promptsDir, filename), content);
      logger.debug("Dumped prompt to file", { taskId: opts.taskId, file: filename });
    } catch (err) {
      logger.warn("Failed to dump prompt", { error: String(err) });
    }
  }

  const result = await claudeStream(
    {
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      cwd: opts.containerName ? undefined : opts.workDir,
      model,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      mcpConfigPath: opts.mcpConfigPath,
      addDirs: opts.addDirs,
      containerName: opts.containerName,
      containerWorkDir: opts.containerWorkDir,
    },
    (evt: ClaudeEvent) => {
      storeStreamEvent(opts.agentRunId, evt.type, evt.content);
      opts.onEvent?.(evt.type, evt.content);
    },
  );

  logger.info("claude subprocess completed", {
    agentRunId: opts.agentRunId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd.toFixed(4),
  });

  return {
    output: result.text,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd: result.usage.costUsd,
    },
    error: result.error,
  };
}

export async function generateMcpConfig(
  taskId: string,
  workDir: string,
  repoName: string,
  opts?: { sandboxed?: boolean; containerWorkDir?: string }
): Promise<string> {
  const configPath = join(taskDir(taskId), "mcp-config.json");

  let mcpConfig: Record<string, unknown>;

  if (opts?.sandboxed) {
    // Inside a container, use HTTP transport to reach MCP server on the host.
    // host.docker.internal resolves to the host from inside Docker.
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
    // On the host, use stdio transport as before.
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
