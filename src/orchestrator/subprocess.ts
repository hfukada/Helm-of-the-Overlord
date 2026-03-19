import { Subprocess } from "bun";
import { logger } from "../shared/logger";
import type { ClaudeStreamEvent, TokenUsage, StreamEventType } from "../shared/types";
import { getDb } from "../knowledge/db";
import { config } from "../shared/config";

export interface SubprocessOptions {
  prompt: string;
  systemPrompt?: string;
  workDir: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  agentRunId: string;
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
  model: string
): number {
  // Default to sonnet pricing
  const inputCost = (inputTokens / 1_000_000) * SONNET_INPUT_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * SONNET_OUTPUT_COST_PER_MILLION;
  return inputCost + outputCost;
}

function storeStreamEvent(
  agentRunId: string,
  eventType: StreamEventType,
  content: string
): void {
  const db = getDb();
  db.run(
    "INSERT INTO agent_stream (agent_run_id, event_type, content) VALUES (?, ?, ?)",
    [agentRunId, eventType, content]
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

  let totalOutput = "";
  let totalInput = 0;
  let totalOutput_tokens = 0;
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
        if (!line.trim()) continue;

        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            totalOutput += event.delta.text;
            storeStreamEvent(opts.agentRunId, "text", event.delta.text);
            opts.onEvent?.("text", event.delta.text);
          } else if (
            event.delta.type === "thinking_delta" &&
            event.delta.thinking
          ) {
            storeStreamEvent(opts.agentRunId, "thinking", event.delta.thinking);
            opts.onEvent?.("thinking", event.delta.thinking);
          } else if (
            event.delta.type === "input_json_delta" &&
            event.delta.partial_json
          ) {
            storeStreamEvent(
              opts.agentRunId,
              "tool_use",
              event.delta.partial_json
            );
            opts.onEvent?.("tool_use", event.delta.partial_json);
          }
        } else if (
          event.type === "content_block_start" &&
          event.content_block
        ) {
          if (event.content_block.type === "tool_use" && event.content_block.name) {
            const info = `Tool: ${event.content_block.name}`;
            storeStreamEvent(opts.agentRunId, "tool_use", info);
            opts.onEvent?.("tool_use", info);
          }
        } else if (event.type === "message_delta" && event.usage) {
          totalOutput_tokens += event.usage.output_tokens ?? 0;
        } else if (event.type === "message_start" && event.usage) {
          totalInput += event.usage.input_tokens ?? 0;
        } else if (event.type === "result" && event.result?.usage) {
          totalInput = event.result.usage.input_tokens;
          totalOutput_tokens = event.result.usage.output_tokens;
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    storeStreamEvent(opts.agentRunId, "error", error);
    opts.onEvent?.("error", error);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    error = `claude exited with code ${exitCode}: ${stderr}`;
    logger.error("claude subprocess failed", { error, exitCode });
  }

  const cost = estimateCost(totalInput, totalOutput_tokens, model);

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
