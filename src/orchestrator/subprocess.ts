
import { join, resolve } from "node:path";
import { logger } from "../shared/logger";
import type { TokenUsage, StreamEventType } from "../shared/types";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";
import { registerSubprocess, unregisterSubprocess } from "./subprocess-registry";
import { parseStreamLine } from "./stream-parser";
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

const SONNET_INPUT_COST_PER_MILLION = 3.0;
const SONNET_OUTPUT_COST_PER_MILLION = 15.0;

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  _model: string
): number {
  // Default to sonnet pricing
  const inputCost = (inputTokens / 1_000_000) * SONNET_INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * SONNET_OUTPUT_COST_PER_MILLION;
  return inputCost + outputCost;
}

function storeStreamEvent(
  agentRunId: string,
  eventType: StreamEventType,
  content: unknown
): void {
  // Defensive: ensure content is always a string for SQLite
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
  const args = [
    "claude",
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--model", model,
  ];

  if (opts.maxTurns) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  if (opts.allowedTools?.length) {
    for (const tool of opts.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  if (opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }

  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  args.push("--", opts.prompt);

  logger.info("Spawning claude subprocess", {
    model,
    workDir: opts.workDir,
    agentRunId: opts.agentRunId,
  });

  const proc = Bun.spawn(args, {
    cwd: opts.workDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  if (opts.taskId) {
    registerSubprocess(opts.taskId, proc);
  }

  let totalOutput = "";
  let totalInput = 0;
  let totalOutput_tokens = 0;
  let totalCostUsd: number | null = null;
  let error: string | null = null;

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseStreamLine(line);
        if (!parsed) continue;

        for (const evt of parsed.events) {
          storeStreamEvent(opts.agentRunId, evt.eventType, evt.content);
          opts.onEvent?.(evt.eventType, evt.content);
        }

        totalOutput += parsed.textOutput;

        if (parsed.usage) {
          if (parsed.finalOutput !== null) {
            // Result line: replace totals
            totalInput = parsed.usage.input_tokens || totalInput;
            totalOutput_tokens = parsed.usage.output_tokens || totalOutput_tokens;
          } else {
            // Turn-level usage: accumulate
            totalInput += parsed.usage.input_tokens;
            totalOutput_tokens += parsed.usage.output_tokens;
          }
        }

        if (parsed.finalOutput !== null) {
          totalOutput = parsed.finalOutput;
        }
        if (parsed.totalCostUsd !== null) {
          totalCostUsd = parsed.totalCostUsd;
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    storeStreamEvent(opts.agentRunId, "error", error);
    opts.onEvent?.("error", error);
  }

  if (opts.taskId) {
    unregisterSubprocess(opts.taskId, proc);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !error) {
    const stderr = await new Response(proc.stderr).text();
    error = `claude exited with code ${exitCode}: ${stderr}`;
    logger.error("claude subprocess failed", { error, exitCode });
  }

  // Use actual cost from Claude CLI if available, otherwise estimate
  const cost = totalCostUsd ?? estimateCost(totalInput, totalOutput_tokens, model);

  logger.info("claude subprocess completed", {
    agentRunId: opts.agentRunId,
    inputTokens: totalInput,
    outputTokens: totalOutput_tokens,
    costUsd: cost.toFixed(4),
  });

  return {
    output: totalOutput,
    usage: {
      input_tokens: totalInput,
      output_tokens: totalOutput_tokens,
      cost_usd: cost,
    },
    error,
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
