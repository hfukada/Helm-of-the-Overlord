
import { join, resolve } from "node:path";
import { logger } from "../shared/logger";
import type { TokenUsage, StreamEventType } from "../shared/types";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";
import { claudeBatch, type ClaudeEvent } from "../shared/claude-cli";
import { taskDir } from "../workspace/manager";

export interface SubprocessOptions {
  prompt: string;
  systemPrompt?: string;
  workDir: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  mcpConfigPath?: string;
  agentRunId: string;
  taskId?: string;
  onEvent?: (eventType: StreamEventType, content: string) => void;
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

  const result = await claudeBatch(
    {
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      cwd: opts.workDir,
      model,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      mcpConfigPath: opts.mcpConfigPath,
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
  repoName: string
): Promise<string> {
  const serverScript = resolve(join(import.meta.dir, "../mcp/server.ts"));
  const configPath = join(taskDir(taskId), "mcp-config.json");

  const mcpConfig = {
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

  await Bun.write(configPath, JSON.stringify(mcpConfig, null, 2));
  logger.info("Generated MCP config", { taskId, configPath });
  return configPath;
}
