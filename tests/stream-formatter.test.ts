import { describe, test, expect } from "bun:test";
import {
  StreamFormatter,
  formatToolUse,
  formatToolArgs,
  type FormatterOutput,
} from "../src/cli/stream-formatter";

// ---------------------------------------------------------------------------
// Helper: collect formatted output from a sequence of push() calls
// ---------------------------------------------------------------------------

function collect(
  events: Array<[string, string]>,
  opts: { showThinking?: boolean } = {},
): FormatterOutput[] {
  const output: FormatterOutput[] = [];
  const fmt = new StreamFormatter(
    opts.showThinking ?? true,
    (o) => output.push(o),
  );
  for (const [type, content] of events) {
    fmt.push(type, content);
  }
  fmt.flush();
  return output;
}

// ---------------------------------------------------------------------------
// StreamFormatter: thinking buffering
// ---------------------------------------------------------------------------

describe("StreamFormatter: thinking", () => {
  test("buffers thinking deltas into a single output", () => {
    const output = collect([
      ["thinking", "The "],
      ["thinking", "user is "],
      ["thinking", "asking about tools."],
    ]);
    expect(output).toEqual([
      { type: "thinking", content: "The user is asking about tools." },
    ]);
  });

  test("flushes thinking when type changes to text", () => {
    const output = collect([
      ["thinking", "Let me think..."],
      ["text", "Here is the answer."],
    ]);
    expect(output).toEqual([
      { type: "thinking", content: "Let me think..." },
      { type: "text", content: "Here is the answer." },
    ]);
  });

  test("flushes thinking when type changes to tool_use", () => {
    const output = collect([
      ["thinking", "I need to search."],
      ["tool_use", "Tool: Grep"],
    ]);
    expect(output).toEqual([
      { type: "thinking", content: "I need to search." },
      // tool_use buffered, flushed at end
      { type: "tool", content: "Grep" },
    ]);
  });

  test("suppresses thinking when showThinking is false", () => {
    const output = collect(
      [
        ["thinking", "secret thoughts"],
        ["text", "visible answer"],
      ],
      { showThinking: false },
    );
    expect(output).toEqual([
      { type: "text", content: "visible answer" },
    ]);
  });

  test("skips empty thinking buffer", () => {
    const output = collect([
      ["thinking", "   "],
      ["text", "answer"],
    ]);
    // whitespace-only thinking should be suppressed
    expect(output).toEqual([
      { type: "text", content: "answer" },
    ]);
  });

  test("truncates thinking over 500 chars", () => {
    const longThinking = "x".repeat(600);
    const output = collect([["thinking", longThinking]]);
    expect(output.length).toBe(1);
    expect(output[0].type).toBe("thinking");
    expect(output[0].content.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(output[0].content.endsWith("...")).toBe(true);
  });

  test("handles multiple thinking blocks separated by other events", () => {
    const output = collect([
      ["thinking", "first thought"],
      ["text", "some text"],
      ["thinking", "second thought"],
    ]);
    expect(output).toEqual([
      { type: "thinking", content: "first thought" },
      { type: "text", content: "some text" },
      { type: "thinking", content: "second thought" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// StreamFormatter: tool_use buffering
// ---------------------------------------------------------------------------

describe("StreamFormatter: tool_use", () => {
  test("buffers tool_use start + json deltas into single output", () => {
    const output = collect([
      ["tool_use", "Tool: Grep"],
      ["tool_use", '{"patt'],
      ["tool_use", 'ern": "al'],
      ["tool_use", 'lowedTools"}'],
    ]);
    expect(output).toEqual([
      { type: "tool", content: 'Grep: pattern="allowedTools"' },
    ]);
  });

  test("handles tool_use with no JSON args", () => {
    const output = collect([
      ["tool_use", "Tool: Bash"],
    ]);
    expect(output).toEqual([
      { type: "tool", content: "Bash" },
    ]);
  });

  test("handles multiple tool calls", () => {
    const output = collect([
      ["tool_use", "Tool: Grep"],
      ["tool_use", '{"pattern": "foo"}'],
      ["tool_result", "Found 3 files"],
      ["tool_use", "Tool: Read"],
      ["tool_use", '{"file_path": "/tmp/test.ts"}'],
    ]);
    expect(output).toEqual([
      { type: "tool", content: 'Grep: pattern="foo"' },
      { type: "result", content: "Found 3 files" },
      { type: "tool", content: 'Read: file_path="/tmp/test.ts"' },
    ]);
  });

  test("handles tool_use with partial/malformed JSON", () => {
    const output = collect([
      ["tool_use", "Tool: Bash"],
      ["tool_use", '{"command": "git sta'],
      // stream ended before JSON completed
    ]);
    expect(output.length).toBe(1);
    expect(output[0].type).toBe("tool");
    // Should show what we have, not crash
    expect(output[0].content).toContain("Bash");
    expect(output[0].content).toContain("git sta");
  });
});

// ---------------------------------------------------------------------------
// StreamFormatter: tool_result (immediate, not buffered)
// ---------------------------------------------------------------------------

describe("StreamFormatter: tool_result", () => {
  test("outputs tool_result immediately without buffering", () => {
    const output = collect([
      ["tool_result", "file contents here"],
    ]);
    expect(output).toEqual([
      { type: "result", content: "file contents here" },
    ]);
  });

  test("truncates long tool_result", () => {
    const longResult = "x".repeat(200);
    const output = collect([["tool_result", longResult]]);
    expect(output.length).toBe(1);
    expect(output[0].content.length).toBeLessThanOrEqual(123); // 120 + "..."
    expect(output[0].content.endsWith("...")).toBe(true);
  });

  test("flushes pending buffer before tool_result", () => {
    const output = collect([
      ["thinking", "analyzing..."],
      ["tool_result", "result data"],
    ]);
    expect(output).toEqual([
      { type: "thinking", content: "analyzing..." },
      { type: "result", content: "result data" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// StreamFormatter: text (pass-through, not buffered)
// ---------------------------------------------------------------------------

describe("StreamFormatter: text", () => {
  test("passes text through immediately", () => {
    const output = collect([
      ["text", "Hello "],
      ["text", "world"],
    ]);
    expect(output).toEqual([
      { type: "text", content: "Hello " },
      { type: "text", content: "world" },
    ]);
  });

  test("flushes pending buffer before text", () => {
    const output = collect([
      ["tool_use", "Tool: Read"],
      ["tool_use", '{"file_path": "/foo"}'],
      ["text", "The answer is..."],
    ]);
    expect(output).toEqual([
      { type: "tool", content: 'Read: file_path="/foo"' },
      { type: "text", content: "The answer is..." },
    ]);
  });
});

// ---------------------------------------------------------------------------
// StreamFormatter: full realistic sequence
// ---------------------------------------------------------------------------

describe("StreamFormatter: realistic sequence", () => {
  test("formats a complete ask interaction", () => {
    const output = collect([
      // Thinking deltas (token-by-token)
      ["thinking", "The "],
      ["thinking", "user wants "],
      ["thinking", "to know about tools."],
      // Tool use
      ["tool_use", "Tool: Grep"],
      ["tool_use", '{"pattern"'],
      ["tool_use", ': "allowed'],
      ["tool_use", 'Tools", "path"'],
      ["tool_use", ': "/home/user/project"}'],
      // Tool result
      ["tool_result", "src/orchestrator/nodes/agentic/plan.ts\nsrc/orchestrator/nodes/agentic/implement.ts"],
      // Another tool
      ["tool_use", "Tool: Read"],
      ["tool_use", '{"file_path": "/home/user/project/src/orchestrator/nodes/agentic/plan.ts"}'],
      // Tool result
      ["tool_result", "const allowedTools = [\"Read\", \"Glob\", \"Grep\"];"],
      // More thinking
      ["thinking", "Now I have the info."],
      // Answer text
      ["text", "Yes, "],
      ["text", "there is a tools list. "],
      ["text", "Each node defines its own allowedTools array."],
    ]);

    expect(output).toEqual([
      { type: "thinking", content: "The user wants to know about tools." },
      { type: "tool", content: 'Grep: pattern="allowedTools", path="/home/user/project"' },
      { type: "result", content: "src/orchestrator/nodes/agentic/plan.ts\nsrc/orchestrator/nodes/agentic/implement.ts" },
      { type: "tool", content: 'Read: file_path="/home/user/project/src/orchestrator/nodes/agentic/plan.ts"' },
      { type: "result", content: 'const allowedTools = ["Read", "Glob", "Grep"];' },
      { type: "thinking", content: "Now I have the info." },
      { type: "text", content: "Yes, " },
      { type: "text", content: "there is a tools list. " },
      { type: "text", content: "Each node defines its own allowedTools array." },
    ]);
  });
});

// ---------------------------------------------------------------------------
// formatToolUse (unit)
// ---------------------------------------------------------------------------

describe("formatToolUse", () => {
  test("parses stream-mode tool start + JSON", () => {
    const result = formatToolUse('Tool: Grep{"pattern": "foo", "path": "/bar"}');
    expect(result).toBe('Grep: pattern="foo", path="/bar"');
  });

  test("parses tool name only", () => {
    expect(formatToolUse("Tool: Bash")).toBe("Bash");
  });

  test("parses batch-mode tool format", () => {
    const result = formatToolUse('Read: {"file_path": "/tmp/test.txt"}');
    expect(result).toBe('Read: file_path="/tmp/test.txt"');
  });

  test("handles malformed JSON gracefully", () => {
    const result = formatToolUse('Tool: Bash{"command": "git sta');
    expect(result).toContain("Bash");
    expect(result).toContain("git sta");
  });

  test("handles unknown format", () => {
    const result = formatToolUse("something unexpected");
    expect(result).toBe("something unexpected");
  });

  test("truncates long unknown format", () => {
    const long = "x".repeat(300);
    expect(formatToolUse(long).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// formatToolArgs (unit)
// ---------------------------------------------------------------------------

describe("formatToolArgs", () => {
  test("formats string values with quotes", () => {
    expect(formatToolArgs({ pattern: "foo" })).toBe('pattern="foo"');
  });

  test("formats multiple args comma-separated", () => {
    expect(formatToolArgs({ pattern: "foo", path: "/bar" })).toBe(
      'pattern="foo", path="/bar"',
    );
  });

  test("formats non-string values as JSON", () => {
    expect(formatToolArgs({ limit: 10 })).toBe("limit=10");
    expect(formatToolArgs({ verbose: true })).toBe("verbose=true");
  });

  test("skips null values", () => {
    expect(formatToolArgs({ a: "yes", b: null })).toBe('a="yes"');
  });

  test("truncates long string values", () => {
    const longVal = "x".repeat(100);
    const result = formatToolArgs({ cmd: longVal });
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("...");
  });

  test("handles empty args", () => {
    expect(formatToolArgs({})).toBe("");
  });
});
