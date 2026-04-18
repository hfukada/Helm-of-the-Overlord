/**
 * OllamaAgent -- implements the Agent interface using the Ollama /api/chat
 * REST endpoint with streaming NDJSON and tool-calling support.
 *
 * Tool execution model (Milestone 3 scope):
 *   Ollama produces tool_calls in its response but this agent cannot execute
 *   filesystem tools (Read, Bash, etc.) in-process. Tool calls are emitted as
 *   AgentEvents. After each tool-bearing turn, onTurnComplete() is called to
 *   get a continuation prompt which is injected as a role:"user" message.
 *
 *   NOTE: This means the message history will contain role:"user" continuations
 *   rather than role:"tool" messages with structured results. Models that enforce
 *   strict tool message sequencing may behave unexpectedly. This is a known
 *   limitation of Milestone 3 — full role:"tool" injection is deferred.
 *   A warning is logged when this path is taken.
 *
 * session_id: Ollama has no session concept. The agent_runs.session_id column
 *   is left unchanged (not updated) at run end. This is intentional.
 */

import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { getDb } from "../knowledge/db";
import type { TokenUsage } from "../shared/types";
import type {
  Agent,
  AgentOptions,
  AgentRunOptions,
  AgentRunResult,
  ToolDefinition,
  TurnSummary,
  AgentStopReason,
} from "./types";
import { detectLoop } from "./loop-detection";

// ---------------------------------------------------------------------------
// Ollama REST API types (subset)
// ---------------------------------------------------------------------------

interface OllamaToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OllamaTool {
  type: "function";
  function: OllamaToolFunction;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaStreamChunk {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ---------------------------------------------------------------------------
// OllamaAgent
// ---------------------------------------------------------------------------

export class OllamaAgent implements Agent {
  private readonly model: string;
  private readonly ollamaHost: string;

  constructor(opts: AgentOptions = {}) {
    this.model = opts.model ?? config.ollamaModel;
    this.ollamaHost = config.ollamaHost;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const turns: TurnSummary[] = [];
    const recentToolNames: string[][] = [];
    let lastText = "";
    const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    let error: string | null = null;
    let stopReason: AgentStopReason = "done";

    let db: ReturnType<typeof getDb> | null = null;
    try { db = getDb(); } catch {}

    const ollamaTools = toOllamaTools(opts.tools);

    // Build initial message history.
    const messages: OllamaMessage[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({ role: "user", content: opts.prompt });

    for (let turnNum = 1; turnNum <= opts.maxTurns; turnNum++) {
      const turnToolCalls: Array<{ name: string; args: unknown }> = [];
      let turnText = "";
      let promptEvalCount = 0;
      let evalCount = 0;

      logger.info("Ollama agent turn starting", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        maxTurns: opts.maxTurns,
        model: this.model,
      });

      // POST to Ollama /api/chat with streaming.
      let response: Response;
      try {
        response = await fetch(`${this.ollamaHost}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages,
            tools: ollamaTools.length > 0 ? ollamaTools : undefined,
            stream: true,
          }),
        });
      } catch (fetchErr) {
        const msg = `Ollama fetch failed: ${String(fetchErr)}`;
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      // Handle non-200 before attempting NDJSON parsing.
      if (!response.ok) {
        let body = "";
        try { body = await response.text(); } catch {}
        const msg = `Ollama returned HTTP ${response.status}: ${body.slice(0, 500)}`;
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      // Parse streaming NDJSON response line by line.
      const accumulated: OllamaStreamChunk[] = [];
      try {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let chunk: OllamaStreamChunk;
            try {
              chunk = JSON.parse(trimmed);
            } catch {
              // Non-JSON line -- skip.
              continue;
            }
            accumulated.push(chunk);
            if (chunk.message?.content) {
              turnText += chunk.message.content;
            }
            if (chunk.prompt_eval_count) promptEvalCount = chunk.prompt_eval_count;
            if (chunk.eval_count) evalCount = chunk.eval_count;
          }
        }
      } catch (streamErr) {
        const msg = `Ollama stream read failed: ${String(streamErr)}`;
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      // Collect tool_calls from the final non-empty chunk.
      const finalChunk = accumulated[accumulated.length - 1];
      const rawToolCalls: OllamaToolCall[] = finalChunk?.message?.tool_calls ?? [];
      for (const tc of rawToolCalls) {
        const name = tc.function.name;
        const args = tc.function.arguments;
        turnToolCalls.push({ name, args });
        opts.onEvent?.({ type: "tool_call", turnNumber: turnNum, toolName: name, args });
      }

      // Emit accumulated text.
      if (turnText) {
        opts.onEvent?.({ type: "text", turnNumber: turnNum, content: turnText });
      }

      const turnUsage: TokenUsage = {
        input_tokens: promptEvalCount,
        output_tokens: evalCount,
        cost_usd: 0,
      };

      const turn: TurnSummary = {
        turnNumber: turnNum,
        text: turnText,
        toolCalls: turnToolCalls,
        hasToolUse: turnToolCalls.length > 0,
        usage: turnUsage,
      };

      turns.push(turn);
      recentToolNames.push(turnToolCalls.map((tc) => tc.name));
      if (recentToolNames.length > 5) recentToolNames.shift();

      totalUsage.input_tokens += turnUsage.input_tokens;
      totalUsage.output_tokens += turnUsage.output_tokens;
      if (turn.text) lastText = turn.text;

      // Per-turn DB logging.
      try {
        db?.run(
          `INSERT INTO agent_turns (agent_run_id, turn_number, has_tool_use, tool_names, text_output, input_tokens, output_tokens, cost_usd, stop_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            opts.agentRunId,
            turnNum,
            turn.hasToolUse ? 1 : 0,
            turnToolCalls.length > 0 ? JSON.stringify(turnToolCalls.map((tc) => tc.name)) : null,
            turn.text ? turn.text.slice(0, 5000) : null,
            turnUsage.input_tokens,
            turnUsage.output_tokens,
            0,
            turn.hasToolUse ? "tool_use" : "end_turn",
          ],
        );
      } catch (err) {
        logger.warn("Failed to log agent turn", { error: String(err) });
      }

      logger.info("Ollama agent turn complete", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        hasToolUse: turn.hasToolUse,
        toolCalls: turnToolCalls.map((tc) => tc.name),
        textLen: turn.text.length,
        tokens: turnUsage.input_tokens + turnUsage.output_tokens,
      });

      if (opts.shouldStop?.(turn)) {
        stopReason = "cancelled";
        break;
      }

      if (!turn.hasToolUse) {
        // Pure text reply — push assistant message and stop.
        messages.push({ role: "assistant", content: turnText });
        stopReason = "done";
        break;
      }

      if (turnNum >= opts.maxTurns) {
        stopReason = "max_turns";
        break;
      }

      if (detectLoop(recentToolNames)) {
        logger.warn("Ollama agent loop detected -- repeating tool pattern", {
          agentRunId: opts.agentRunId,
          turn: turnNum,
          pattern: recentToolNames.slice(-3),
        });
      }

      // Push the assistant message with tool_calls onto the history.
      messages.push({
        role: "assistant",
        content: turnText,
        tool_calls: rawToolCalls,
      });

      // Milestone 3 limitation: we cannot inject role:"tool" messages because
      // tools are not executed in-process. Instead, call onTurnComplete() to get
      // a continuation string and push it as role:"user". Models that enforce strict
      // tool message sequencing may behave unexpectedly. Log a warning.
      logger.warn(
        "OllamaAgent: injecting tool results as role:user (Milestone 3 limitation -- role:tool not yet supported)",
        { agentRunId: opts.agentRunId, turn: turnNum, toolCalls: turnToolCalls.map((tc) => tc.name) },
      );
      const injected = opts.onTurnComplete ? await opts.onTurnComplete(turn) : null;
      const continuation = injected ?? "continue";
      messages.push({ role: "user", content: continuation });
    }

    const output = lastText || (turns.length > 0 ? turns[turns.length - 1].text : "");

    // NOTE: Ollama has no session concept. agent_runs.session_id is not updated.

    logger.info("Ollama agent run complete", {
      agentRunId: opts.agentRunId,
      totalTurns: turns.length,
      stopReason,
      totalTokens: totalUsage.input_tokens + totalUsage.output_tokens,
    });

    return {
      output,
      turns,
      totalUsage,
      error,
      stopReason,
      metadata: { provider: "ollama", model: this.model },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema as Record<string, unknown>) ?? {},
    },
  }));
}
