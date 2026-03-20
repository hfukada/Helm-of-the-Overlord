import { describe, test, expect } from "bun:test";
import {
  parseBatchLine,
  parseStreamLine,
  claudeText,
  claudeJSON,
  claudeBatch,
  claudeStream,
  type ClaudeEvent,
} from "../src/shared/claude-cli";

// ---------------------------------------------------------------------------
// Unit tests: parseBatchLine (Mode 3 -- verbose stream-json, no partials)
// ---------------------------------------------------------------------------

describe("parseBatchLine", () => {
  test("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello world");
    expect(result!.events).toEqual([{ type: "text", content: "Hello world" }]);
  });

  test("parses assistant thinking block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.events).toEqual([{ type: "thinking", content: "Let me think..." }]);
    expect(result!.text).toBe("");
  });

  test("parses assistant tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/tmp/test.txt" },
        }],
      },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.events.length).toBe(1);
    expect(result!.events[0].type).toBe("tool_use");
    expect(result!.events[0].content).toContain("Read");
  });

  test("parses user tool_result block", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: "file contents here",
        }],
      },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.events[0].type).toBe("tool_result");
    expect(result!.events[0].content).toBe("file contents here");
  });

  test("parses result line with usage and cost", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Final answer text",
      total_cost_usd: 0.0053,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.result).toBe("Final answer text");
    expect(result!.usage).not.toBeNull();
    expect(result!.usage!.inputTokens).toBe(100);
    expect(result!.usage!.outputTokens).toBe(50);
    expect(result!.usage!.costUsd).toBe(0.0053);
  });

  test("parses result line with is_error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Something went wrong",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.result).toBe("Something went wrong");
  });

  test("skips system init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-sonnet-4-6",
    });
    expect(parseBatchLine(line)).toBeNull();
  });

  test("skips rate_limit_event line", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed" },
    });
    expect(parseBatchLine(line)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseBatchLine("")).toBeNull();
    expect(parseBatchLine("  ")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseBatchLine("not json")).toBeNull();
    expect(parseBatchLine("{broken")).toBeNull();
  });

  test("handles multiple content blocks in one message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "analyzing..." },
          { type: "text", text: "The answer is 42" },
        ],
      },
    });
    const result = parseBatchLine(line);
    expect(result).not.toBeNull();
    expect(result!.events.length).toBe(2);
    expect(result!.events[0]).toEqual({ type: "thinking", content: "analyzing..." });
    expect(result!.events[1]).toEqual({ type: "text", content: "The answer is 42" });
    expect(result!.text).toBe("The answer is 42");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseStreamLine (Mode 4 -- with partial messages)
// ---------------------------------------------------------------------------

describe("parseStreamLine", () => {
  test("parses text_delta stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello");
    expect(result!.events).toEqual([{ type: "text", content: "Hello" }]);
  });

  test("parses thinking_delta stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm..." },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.events).toEqual([{ type: "thinking", content: "hmm..." }]);
    expect(result!.text).toBe("");
  });

  test("parses input_json_delta stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":' },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.events).toEqual([{ type: "tool_use", content: '{"file_path":' }]);
  });

  test("parses content_block_start for tool_use", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read", id: "toolu_123" },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.events).toEqual([{ type: "tool_use", content: "Tool: Read" }]);
  });

  test("skips content_block_start for text (no useful info)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("skips message_start stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "message_start", message: {} },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("skips message_stop stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "message_stop" },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("skips content_block_stop stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("falls through to parseBatchLine for assistant type", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "complete message" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("complete message");
  });

  test("falls through to parseBatchLine for result type", () => {
    const line = JSON.stringify({
      type: "result",
      result: "final answer",
      total_cost_usd: 0.01,
      usage: { input_tokens: 200, output_tokens: 100 },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.result).toBe("final answer");
    expect(result!.usage!.costUsd).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: actual Claude CLI invocation
// ---------------------------------------------------------------------------

describe("claudeText (integration)", () => {
  test("returns a text response", async () => {
    const result = await claudeText({
      prompt: "Reply with exactly: PONG",
      maxTurns: 1,
    });
    expect(result).toContain("PONG");
  }, 30_000);
});

describe("claudeJSON (integration)", () => {
  test("returns result with usage", async () => {
    const result = await claudeJSON({
      prompt: "Reply with exactly: PONG",
      maxTurns: 1,
    });
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  }, 30_000);
});

describe("claudeBatch (integration)", () => {
  test("returns result and fires events", async () => {
    const events: ClaudeEvent[] = [];
    const result = await claudeBatch(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
      (evt) => events.push(evt),
    );
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");
    expect(result.usage.costUsd).toBeGreaterThan(0);
    // Should have at least one text event
    expect(events.some((e) => e.type === "text")).toBe(true);
  }, 30_000);
});

describe("claudeStream (integration)", () => {
  test("streams incremental deltas and returns result", async () => {
    const events: ClaudeEvent[] = [];
    const result = await claudeStream(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
      (evt) => { events.push(evt); },
    );
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");
    expect(result.usage.costUsd).toBeGreaterThan(0);
    // Stream mode should have text events from deltas
    expect(events.some((e) => e.type === "text")).toBe(true);
  }, 30_000);

  test("streams tool use events", async () => {
    const events: ClaudeEvent[] = [];
    const result = await claudeStream(
      {
        prompt: "Read the file package.json and tell me the project name",
        maxTurns: 2,
        allowedTools: ["Read"],
        cwd: "/home/hiroshi/src/helm-of-the-overlord",
      },
      (evt) => { events.push(evt); },
    );
    expect(result.error).toBeNull();
    expect(result.text.length).toBeGreaterThan(0);
    // Should have tool_use events
    expect(events.some((e) => e.type === "tool_use")).toBe(true);
    // Should have tool_result events (from batch-line fallthrough)
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  }, 60_000);
});
