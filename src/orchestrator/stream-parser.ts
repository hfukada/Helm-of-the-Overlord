import type { ClaudeStreamEvent, StreamEventType } from "../shared/types";

export interface ParsedEvent {
  eventType: StreamEventType;
  content: string;
}

export interface UsageDelta {
  input_tokens: number;
  output_tokens: number;
}

export interface ParseLineResult {
  events: ParsedEvent[];
  textOutput: string;
  usage: UsageDelta | null;
  /** If this is a "result" line, the final output text */
  finalOutput: string | null;
  /** If this is a "result" line, the total cost */
  totalCostUsd: number | null;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

/**
 * Parse a single JSON line from claude CLI stream-json output.
 * Returns extracted events, text output, and usage info.
 * Returns null if the line is not parseable or not relevant.
 */
export function parseStreamLine(line: string): ParseLineResult | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const events: ParsedEvent[] = [];
  let textOutput = "";
  let usage: UsageDelta | null = null;
  let finalOutput: string | null = null;
  let totalCostUsd: number | null = null;

  if (outer.type === "assistant" || outer.type === "user") {
    const msg = outer.message as {
      content?: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | undefined;

    if (msg?.content) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textOutput += block.text;
          events.push({ eventType: "text", content: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ eventType: "thinking", content: block.thinking });
        } else if (block.type === "tool_use" && block.name) {
          events.push({ eventType: "tool_use", content: `Tool: ${block.name}` });
          if (block.input != null) {
            const inputStr = JSON.stringify(block.input, null, 2);
            events.push({ eventType: "tool_use", content: inputStr });
          }
        } else if (block.type === "tool_result") {
          let content: string;
          if (typeof block.content === "string") {
            content = block.content;
          } else if (block.content != null) {
            content = JSON.stringify(block.content);
          } else {
            content = safeStringify(block);
          }
          events.push({ eventType: "tool_result", content: content.slice(0, 2000) });
        }
      }
    }

    if (msg?.usage) {
      usage = {
        input_tokens: msg.usage.input_tokens ?? 0,
        output_tokens: msg.usage.output_tokens ?? 0,
      };
    }
  } else if (outer.type === "result") {
    const resultUsage = outer.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (resultUsage) {
      usage = {
        input_tokens: resultUsage.input_tokens ?? 0,
        output_tokens: resultUsage.output_tokens ?? 0,
      };
    }
    if (typeof outer.result === "string" && outer.result) {
      finalOutput = outer.result;
    }
    if (typeof outer.total_cost_usd === "number") {
      totalCostUsd = outer.total_cost_usd;
    }
  } else if (outer.type === "stream_event" && outer.event) {
    const event = outer.event as ClaudeStreamEvent;
    if (event.type === "content_block_delta" && event.delta) {
      if (event.delta.type === "text_delta" && event.delta.text) {
        textOutput += event.delta.text;
        events.push({ eventType: "text", content: event.delta.text });
      } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
        events.push({ eventType: "thinking", content: event.delta.thinking });
      } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
        events.push({ eventType: "tool_use", content: event.delta.partial_json });
      }
    } else if (event.type === "content_block_start" && event.content_block) {
      if (event.content_block.type === "tool_use" && event.content_block.name) {
        events.push({ eventType: "tool_use", content: `Tool: ${event.content_block.name}` });
      }
    }
  } else {
    // system, rate_limit_event, etc. -- not relevant
    return null;
  }

  return { events, textOutput, usage, finalOutput, totalCostUsd };
}
