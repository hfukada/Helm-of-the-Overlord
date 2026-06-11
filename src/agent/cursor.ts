/**
 * CursorAgent -- implements the Agent interface using the Cursor API
 * (OpenAI-compatible HTTP endpoint) with SSE streaming and tool-calling.
 *
 * Tool execution model: same as OllamaAgent -- tools are executed in-process
 * via tool-executor.ts. Results are injected as role:"tool" messages with
 * matching tool_call_id fields.
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
import { executeTool } from "./tool-executor";

// ---------------------------------------------------------------------------
// Cursor REST API types (OpenAI-compatible subset)
// ---------------------------------------------------------------------------

interface CursorToolFunction {
  name: string;
  description?: string;
  parameters: unknown;
}

interface CursorTool {
  type: "function";
  function: CursorToolFunction;
}

interface CursorToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface CursorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: CursorToolCall[];
  tool_call_id?: string;
}

// Accumulator for incremental tool_call chunks (OpenAI streaming spec).
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface CursorStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ---------------------------------------------------------------------------
// CursorAgent
// ---------------------------------------------------------------------------

export class CursorAgent implements Agent {
  private readonly model: string;

  constructor(opts: AgentOptions = {}) {
    this.model = opts.model ?? config.cursorModel;
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

    const messages: CursorMessage[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({ role: "user", content: opts.prompt });

    for (let turnNum = 1; turnNum <= opts.maxTurns; turnNum++) {
      const turnToolCalls: Array<{ name: string; args: unknown }> = [];
      let contentAccum = "";

      logger.info("Cursor agent turn starting", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        maxTurns: opts.maxTurns,
        model: this.model,
      });

      const requestBody = {
        model: this.model,
        messages,
        tools: toCursorTools(opts.tools ?? []),
        stream: true,
        stream_options: { include_usage: true },
      };

      let response: Response;
      try {
        response = await fetch("https://api.cursor.sh/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.cursorApiKey}`,
          },
          body: JSON.stringify(requestBody),
        });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      if (!response.ok) {
        let body = "";
        try { body = await response.text(); } catch {}
        const msg = `HTTP ${response.status}: ${body.slice(0, 500)}`;
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      // Parse SSE stream (OpenAI format).
      const partialCalls = new Map<number, PartialToolCall>();
      let usageFromStream: { prompt_tokens: number; completion_tokens: number } | undefined;

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
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") break;
            let chunk: CursorStreamChunk;
            try { chunk = JSON.parse(payload); } catch { continue; }

            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) contentAccum += delta.content;

            for (const tc of delta?.tool_calls ?? []) {
              const idx = tc.index;
              if (!partialCalls.has(idx)) {
                partialCalls.set(idx, { id: "", name: "", arguments: "" });
              }
              const acc = partialCalls.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }

            if (chunk.usage) usageFromStream = chunk.usage;
          }
        }
      } catch (streamErr) {
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        error = msg;
        stopReason = "error";
        opts.onEvent?.({ type: "error", turnNumber: turnNum, content: msg });
        break;
      }

      // Finalize tool calls from per-index accumulator.
      const rawToolCalls: CursorToolCall[] = Array.from(partialCalls.entries())
        .sort(([a], [b]) => a - b)
        .map(([, pc], arrayIdx) => ({
          id: pc.id || `call_${turnNum}_${arrayIdx}`,
          type: "function",
          function: { name: pc.name, arguments: pc.arguments },
        }));

      // Emit text event.
      if (contentAccum) {
        opts.onEvent?.({ type: "text", turnNumber: turnNum, content: contentAccum });
      }

      // Emit tool_call events and populate turnToolCalls.
      for (const tc of rawToolCalls) {
        let args: unknown;
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
        opts.onEvent?.({ type: "tool_call", turnNumber: turnNum, toolName: tc.function.name, args });
        turnToolCalls.push({ name: tc.function.name, args });
      }

      const turnUsage: TokenUsage = {
        input_tokens: usageFromStream?.prompt_tokens ?? 0,
        output_tokens: usageFromStream?.completion_tokens ?? 0,
        cost_usd: 0,
      };

      const turn: TurnSummary = {
        turnNumber: turnNum,
        text: contentAccum,
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

      logger.info("Cursor agent turn complete", {
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
        messages.push({ role: "assistant", content: contentAccum || null });
        stopReason = "done";
        break;
      }

      if (turnNum >= opts.maxTurns) {
        messages.push({ role: "assistant", content: contentAccum || null, tool_calls: rawToolCalls });
        stopReason = "max_turns";
        break;
      }

      if (detectLoop(recentToolNames)) {
        logger.warn("Cursor agent loop detected -- repeating tool pattern", {
          agentRunId: opts.agentRunId,
          turn: turnNum,
          pattern: recentToolNames.slice(-3),
        });
      }

      messages.push({ role: "assistant", content: contentAccum || null, tool_calls: rawToolCalls });

      // Execute each tool in-process and push a role:"tool" result message.
      for (const tc of rawToolCalls) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>; } catch { args = {}; }
        const mcpOpts = opts.repoName !== undefined
          ? { mcpUrl: `http://127.0.0.1:${config.mcpHttpPort}`, repoName: opts.repoName }
          : undefined;
        const result = await executeTool(tc.function.name, args, opts.workDir, mcpOpts);
        opts.onEvent?.({ type: "tool_result", turnNumber: turnNum, toolName: tc.function.name, content: result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    const output = lastText || (turns.length > 0 ? turns[turns.length - 1].text : "");

    logger.info("Cursor agent run complete", {
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
      metadata: { provider: "cursor", model: this.model },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

export function toCursorTools(tools: ToolDefinition[]): CursorTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
