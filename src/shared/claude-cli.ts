/**
 * Typed interface for the Claude CLI.
 *
 * Three output modes, each with its own function:
 *
 * 1. `claudeText`  -- `--print` (default text output)
 *    Returns the final answer as a plain string. Simplest mode.
 *
 * 2. `claudeJSON`  -- `--print --output-format json`
 *    Returns a single JSON object with result text, usage, and cost.
 *    Use when you need token counts but not streaming.
 *
 * 3. `claudeBatch`  -- `--print --verbose --output-format stream-json`
 *    JSONL with complete turn-level messages (assistant, user, result).
 *    No incremental deltas. Each assistant message has full content blocks.
 *    Use when you need per-turn events (tool use, thinking) and usage.
 *
 * 4. `claudeStream` -- `--print --verbose --output-format stream-json --include-partial-messages`
 *    JSONL with incremental token-by-token deltas via `stream_event` lines.
 *    Wraps the raw Anthropic API SSE events: content_block_start/delta/stop.
 *    Use when you need real-time streaming to a UI.
 *
 * All functions accept the same ClaudeOptions for prompt, model, tools, etc.
 * Parsing is handled internally -- callers get typed results.
 */

import { config } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeOptions {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  mcpConfigPath?: string;
  env?: Record<string, string>;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Result from claudeJSON / claudeBatch */
export interface ClaudeResult {
  text: string;
  usage: ClaudeUsage;
  error: string | null;
}

/** A parsed event from batch or stream mode */
export interface ClaudeEvent {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "error";
  content: string;
}

/** Result from claudeStream -- returns final text and usage after stream ends */
export interface ClaudeStreamResult {
  text: string;
  usage: ClaudeUsage;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Argument builder (shared across all modes)
// ---------------------------------------------------------------------------

function buildArgs(opts: ClaudeOptions, extra: string[]): string[] {
  const model = opts.model ?? config.defaultModel;
  const args = ["claude", "--print", ...extra, "--model", model];

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
  return args;
}

function spawnClaude(args: string[], opts: ClaudeOptions) {
  return Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
}

async function getStderr(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  try {
    return await new Response(proc.stderr as ReadableStream).text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Mode 1: Text
// ---------------------------------------------------------------------------

/**
 * Run claude --print and return the plain text output.
 *
 * CLI flags: `claude --print --model <model> [opts...] -- <prompt>`
 *
 * Use for simple one-shot prompts where you only need the text answer.
 */
export async function claudeText(opts: ClaudeOptions): Promise<string> {
  const args = buildArgs(opts, []);
  const proc = spawnClaude(args, opts);

  const [output, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await getStderr(proc);
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`);
  }

  return output.trim();
}

// ---------------------------------------------------------------------------
// Mode 2: JSON
// ---------------------------------------------------------------------------

/**
 * Run claude --print --output-format json and return parsed result.
 *
 * CLI flags: `claude --print --output-format json --model <model> [opts...] -- <prompt>`
 *
 * Returns a single JSON object:
 * ```json
 * {
 *   "type": "result",
 *   "subtype": "success",
 *   "result": "answer text",
 *   "total_cost_usd": 0.005,
 *   "usage": { "input_tokens": 100, "output_tokens": 50 }
 * }
 * ```
 */
export async function claudeJSON(opts: ClaudeOptions): Promise<ClaudeResult> {
  const args = buildArgs(opts, ["--output-format", "json"]);
  const proc = spawnClaude(args, opts);

  const [rawOutput, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await getStderr(proc);
    return {
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: `claude exited with code ${exitCode}: ${stderr}`,
    };
  }

  const data = JSON.parse(rawOutput.trim()) as {
    type: string;
    subtype?: string;
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    text: data.result ?? "",
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      costUsd: data.total_cost_usd ?? 0,
    },
    error: data.is_error ? (data.result ?? "unknown error") : null,
  };
}

// ---------------------------------------------------------------------------
// Mode 3: Batch (verbose stream-json, no partial messages)
// ---------------------------------------------------------------------------

/**
 * Run claude --print --verbose --output-format stream-json.
 *
 * CLI flags: `claude --print --verbose --output-format stream-json --model <model> [opts...] -- <prompt>`
 *
 * JSONL output with complete turn-level messages. No incremental deltas.
 * Each line is one of:
 *
 * - `{type: "system", subtype: "init", ...}` -- session metadata
 * - `{type: "assistant", message: {content: [...]}}` -- full assistant turn
 * - `{type: "user", message: {content: [{type: "tool_result", ...}]}}` -- tool results
 * - `{type: "rate_limit_event", ...}` -- rate limit info
 * - `{type: "result", result: "...", usage: {...}, total_cost_usd: N}` -- final
 *
 * The onEvent callback fires for each content block (text, thinking, tool_use, tool_result).
 * Text blocks arrive complete (not token-by-token).
 */
export async function claudeBatch(
  opts: ClaudeOptions,
  onEvent?: (event: ClaudeEvent) => void,
): Promise<ClaudeResult> {
  const args = buildArgs(opts, ["--verbose", "--output-format", "stream-json"]);
  const proc = spawnClaude(args, opts);

  let text = "";
  let usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let error: string | null = null;

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseBatchLine(line);
        if (!parsed) continue;

        for (const evt of parsed.events) {
          onEvent?.(evt);
        }

        text += parsed.text;

        if (parsed.result !== null) {
          text = parsed.result;
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !error) {
    const stderr = await getStderr(proc);
    error = `claude exited with code ${exitCode}: ${stderr}`;
  }

  return { text, usage, error };
}

// ---------------------------------------------------------------------------
// Mode 4: Stream (verbose stream-json + include-partial-messages)
// ---------------------------------------------------------------------------

/**
 * Run claude --print --verbose --output-format stream-json --include-partial-messages.
 *
 * CLI flags: `claude --print --verbose --output-format stream-json --include-partial-messages --model <model> [opts...] -- <prompt>`
 *
 * JSONL output with incremental token-by-token deltas. In addition to the
 * batch-mode line types, this mode adds `{type: "stream_event"}` lines wrapping
 * raw Anthropic API events:
 *
 * - `stream_event.event.type = "content_block_start"` -- block begins
 *   - `content_block.type` = "text" | "tool_use" | "thinking"
 *   - For tool_use: `content_block.name` = tool name
 * - `stream_event.event.type = "content_block_delta"` -- incremental chunk
 *   - `delta.type = "text_delta"` + `delta.text`
 *   - `delta.type = "thinking_delta"` + `delta.thinking`
 *   - `delta.type = "input_json_delta"` + `delta.partial_json`
 * - `stream_event.event.type = "content_block_stop"` -- block ends
 * - `stream_event.event.type = "message_start/message_delta/message_stop"`
 *
 * The onEvent callback fires for each incremental delta.
 */
export async function claudeStream(
  opts: ClaudeOptions,
  onEvent: (event: ClaudeEvent) => void | Promise<void>,
): Promise<ClaudeStreamResult> {
  const args = buildArgs(opts, [
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
  ]);
  const proc = spawnClaude(args, opts);

  let text = "";
  let usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let error: string | null = null;

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseStreamLine(line);
        if (!parsed) continue;

        // Only fire events from stream_event lines (deltas) and
        // tool_result events from batch fallthrough. Skip text/thinking
        // from assistant batch lines since those duplicate the deltas.
        if (parsed.isStreamEvent) {
          for (const evt of parsed.events) {
            await onEvent(evt);
          }
          text += parsed.text;
        } else {
          // Batch fallthrough: fire only tool_result events (not text/thinking)
          for (const evt of parsed.events) {
            if (evt.type === "tool_result") {
              await onEvent(evt);
            }
          }
        }

        if (parsed.result !== null) {
          text = parsed.result;
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !error) {
    const stderr = await getStderr(proc);
    error = `claude exited with code ${exitCode}: ${stderr}`;
  }

  return { text, usage, error };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface ParsedLine {
  events: ClaudeEvent[];
  text: string;
  result: string | null;
  usage: ClaudeUsage | null;
  /** True when this line came from a stream_event (incremental delta) */
  isStreamEvent?: boolean;
}

/**
 * Parse a single JSONL line from Mode 3 (batch -- no partial messages).
 *
 * Line types: system, assistant, user, rate_limit_event, result
 */
export function parseBatchLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const events: ClaudeEvent[] = [];
  let text = "";
  let result: string | null = null;
  let usage: ClaudeUsage | null = null;

  const type = data.type as string;

  if (type === "assistant" || type === "user") {
    const msg = data.message as {
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: unknown;
        content?: unknown;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | undefined;

    if (msg?.content) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
          events.push({ type: "text", content: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ type: "thinking", content: block.thinking });
        } else if (block.type === "tool_use" && block.name) {
          const inputStr = block.input != null ? JSON.stringify(block.input, null, 2) : "";
          events.push({ type: "tool_use", content: `${block.name}: ${inputStr}` });
        } else if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
          events.push({ type: "tool_result", content: content.slice(0, 2000) });
        }
      }
    }
  } else if (type === "result") {
    if (typeof data.result === "string") {
      result = data.result;
    }
    const u = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    usage = {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      costUsd: (data.total_cost_usd as number) ?? 0,
    };
  } else {
    // system, rate_limit_event -- skip
    return null;
  }

  return { events, text, result, usage };
}

/**
 * Parse a single JSONL line from Mode 4 (stream -- with partial messages).
 *
 * Handles all Mode 3 line types plus `stream_event` with incremental deltas.
 */
export function parseStreamLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // stream_event lines contain incremental deltas
  if (data.type === "stream_event" && data.event) {
    const event = data.event as Record<string, unknown>;
    const eventType = event.type as string;
    const events: ClaudeEvent[] = [];
    let text = "";

    if (eventType === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (delta.type === "text_delta" && delta.text) {
          text = delta.text as string;
          events.push({ type: "text", content: text });
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          events.push({ type: "thinking", content: delta.thinking as string });
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          events.push({ type: "tool_use", content: delta.partial_json as string });
        }
      }
    } else if (eventType === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use" && block.name) {
        events.push({ type: "tool_use", content: `Tool: ${block.name as string}` });
      }
    }
    // message_start, message_delta, message_stop, content_block_stop -- skip

    if (events.length === 0 && text === "") return null;
    return { events, text, result: null, usage: null, isStreamEvent: true };
  }

  // Fall through to batch parser for assistant, user, result lines
  return parseBatchLine(line);
}
