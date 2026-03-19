import { describe, test, expect } from "bun:test";
import { parseStreamLine } from "../stream-parser";

describe("parseStreamLine", () => {
  test("returns null for empty/whitespace lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("\n")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("{broken")).toBeNull();
  });

  test("returns null for system init messages", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc123",
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("parses assistant text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "text", content: "Hello world" },
    ]);
    expect(result?.textOutput).toBe("Hello world");
    expect(result?.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result?.finalOutput).toBeNull();
    expect(result?.totalCostUsd).toBeNull();
  });

  test("parses assistant thinking block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "thinking", content: "Let me think..." },
    ]);
    expect(result?.textOutput).toBe("");
  });

  test("parses assistant tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(2);
    expect(result?.events[0]).toEqual({
      eventType: "tool_use",
      content: "Tool: Read",
    });
    expect(result?.events[1].eventType).toBe("tool_use");
    expect(result?.events[1].content).toContain("/tmp/test.ts");
  });

  test("parses tool_use with null input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: null }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(1);
    expect(result?.events[0].content).toBe("Tool: Bash");
  });

  test("parses user tool_result with string content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "file contents here" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "tool_result", content: "file contents here" },
    ]);
  });

  test("parses user tool_result with array content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "result text" }],
          },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(1);
    expect(result?.events[0].eventType).toBe("tool_result");
    // Array content should be JSON stringified
    expect(result?.events[0].content).toContain("result text");
  });

  test("parses user tool_result with null content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "abc" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(1);
    expect(result?.events[0].eventType).toBe("tool_result");
    // Should stringify the whole block as fallback
    expect(typeof result?.events[0].content).toBe("string");
  });

  test("tool_result content is truncated to 2000 chars", () => {
    const longContent = "x".repeat(3000);
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: longContent }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events[0].content.length).toBe(2000);
  });

  test("parses multiple content blocks in one message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", name: "Glob", input: { pattern: "*.ts" } },
        ],
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events.length).toBe(4); // thinking + text + tool_use header + tool_use input
    expect(result?.textOutput).toBe("answer");
    expect(result?.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
  });

  test("parses result line with usage and cost", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Final answer text",
      usage: { input_tokens: 5000, output_tokens: 2000 },
      total_cost_usd: 0.045,
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.finalOutput).toBe("Final answer text");
    expect(result?.usage).toEqual({ input_tokens: 5000, output_tokens: 2000 });
    expect(result?.totalCostUsd).toBe(0.045);
    expect(result?.events).toEqual([]);
    expect(result?.textOutput).toBe("");
  });

  test("parses result line without cost", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.totalCostUsd).toBeNull();
  });

  test("parses result line with empty result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.finalOutput).toBeNull(); // empty string is falsy
  });

  // stream_event tests (--include-partial-messages mode)
  test("parses stream_event text_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "text", content: "chunk" },
    ]);
    expect(result?.textOutput).toBe("chunk");
  });

  test("parses stream_event thinking_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "reasoning..." },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "thinking", content: "reasoning..." },
    ]);
  });

  test("parses stream_event input_json_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"file' },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "tool_use", content: '{"file' },
    ]);
  });

  test("parses stream_event content_block_start for tool_use", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Edit" },
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      { eventType: "tool_use", content: "Tool: Edit" },
    ]);
  });

  test("all event content values are strings", () => {
    // This is critical for SQLite -- content must never be undefined or object
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Read", input: { path: "/a" } },
            { type: "tool_result", content: ["array", "content"] },
            { type: "tool_result" }, // missing content
          ],
        },
      }),
    ];

    for (const line of lines) {
      const result = parseStreamLine(line);
      if (!result) continue;
      for (const evt of result.events) {
        expect(typeof evt.content).toBe("string");
        expect(evt.content).not.toBe("undefined");
      }
    }
  });

  test("handles message with no content array", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([]);
    expect(result?.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test("handles message with no usage", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hi" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result?.usage).toBeNull();
  });
});
