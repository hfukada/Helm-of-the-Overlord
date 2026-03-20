/**
 * Buffers incremental stream deltas and formats them into readable output.
 *
 * Stream mode (claudeStream / Mode 4) sends token-by-token deltas:
 *   - thinking: many small text fragments
 *   - tool_use: "Tool: Name" start event, then input_json_delta fragments
 *   - tool_result: complete block (from batch-line fallthrough)
 *   - text: incremental answer tokens
 *
 * This formatter accumulates fragments by type and flushes when the event
 * type changes, producing clean grouped output like:
 *   [thinking] The user is asking about...
 *   [tool] Grep: pattern="allowedTools", path="/home/user/project"
 *   [result] Found 5 files...
 *   The answer text streams here incrementally.
 */

export interface FormatterOutput {
  type: "thinking" | "tool" | "result" | "text";
  content: string;
}

export class StreamFormatter {
  private currentType: string | null = null;
  private buffer = "";
  private showThinking: boolean;
  private onOutput: (output: FormatterOutput) => void;

  constructor(
    showThinking: boolean,
    onOutput: (output: FormatterOutput) => void,
  ) {
    this.showThinking = showThinking;
    this.onOutput = onOutput;
  }

  push(eventType: string, content: string): void {
    // Text streams directly -- flush any pending buffer first
    if (eventType === "text") {
      this.flush();
      this.onOutput({ type: "text", content });
      return;
    }

    // tool_result is always complete -- flush and print immediately
    if (eventType === "tool_result") {
      this.flush();
      const truncated = content.length > 120
        ? `${content.slice(0, 120)}...`
        : content;
      this.onOutput({ type: "result", content: truncated });
      return;
    }

    // For thinking and tool_use, accumulate until type changes
    if (eventType !== this.currentType) {
      this.flush();
      this.currentType = eventType;
      this.buffer = content;
    } else {
      this.buffer += content;
    }
  }

  flush(): void {
    if (!this.currentType || !this.buffer) {
      this.currentType = null;
      this.buffer = "";
      return;
    }

    if (this.currentType === "thinking" && this.showThinking) {
      const trimmed = this.buffer.trim();
      if (trimmed) {
        const truncated = trimmed.length > 500
          ? `${trimmed.slice(0, 500)}...`
          : trimmed;
        this.onOutput({ type: "thinking", content: truncated });
      }
    } else if (this.currentType === "tool_use") {
      const formatted = formatToolUse(this.buffer);
      this.onOutput({ type: "tool", content: formatted });
    }

    this.currentType = null;
    this.buffer = "";
  }
}

/**
 * Format a tool_use buffer into a readable one-liner.
 *
 * The buffer typically looks like:
 *   "Tool: Grep" + '{"pattern": "foo", "path": "/bar"}'
 * We parse out the tool name and try to format the JSON args concisely.
 */
export function formatToolUse(raw: string): string {
  // content_block_start produces "Tool: Name", followed by input_json_delta fragments
  const toolMatch = raw.match(/^Tool: (\w+)/);
  if (toolMatch) {
    const name = toolMatch[1];
    const jsonPart = raw.slice(toolMatch[0].length);
    if (jsonPart) {
      try {
        const args = JSON.parse(jsonPart);
        return `${name}: ${formatToolArgs(args)}`;
      } catch {
        // Partial or malformed JSON -- show what we have
        return `${name}: ${jsonPart.slice(0, 200)}`;
      }
    }
    return name;
  }

  // Batch-mode tool_use: "ToolName: {json}"
  const batchMatch = raw.match(/^(\S+): /);
  if (batchMatch) {
    const name = batchMatch[1];
    const jsonPart = raw.slice(batchMatch[0].length);
    try {
      const args = JSON.parse(jsonPart);
      return `${name}: ${formatToolArgs(args)}`;
    } catch {
      return raw.slice(0, 200);
    }
  }

  return raw.slice(0, 200);
}

/** Format tool arguments as a concise key=value string */
export function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string") {
      const display = val.length > 80 ? `${val.slice(0, 80)}...` : val;
      parts.push(`${key}="${display}"`);
    } else if (val != null) {
      parts.push(`${key}=${JSON.stringify(val)}`);
    }
  }
  return parts.join(", ");
}
