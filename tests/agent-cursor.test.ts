import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { ulid } from "ulid";

// ---------------------------------------------------------------------------
// Mocks (must be before importing the agent)
// ---------------------------------------------------------------------------

const executeToolMock = mock(async () => "tool result");

mock.module("../src/agent/tool-executor", () => ({
  executeTool: (...args: unknown[]) => executeToolMock(...args),
}));

mock.module("../src/shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const _realConfig = await import("../src/shared/config");
mock.module("../src/shared/config", () => ({
  config: {
    cursorApiKey: "test-key",
    cursorModel: "cursor-small",
    mcpHttpPort: 7778,
  },
}));

afterAll(() => {
  mock.module("../src/shared/config", () => _realConfig);
});

// Import AFTER mocks.
const { CursorAgent } = await import("../src/agent/cursor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSSEResponse(dataLines: string[]): Response {
  const body = dataLines.map((l) => `data: ${l}`).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

function baseRunOpts() {
  return {
    prompt: "test prompt",
    workDir: "/tmp",
    maxTurns: 10,
    tools: [],
    agentRunId: ulid(),
  };
}

const origFetch = global.fetch;

beforeEach(() => {
  executeToolMock.mockClear();
  global.fetch = origFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CursorAgent", () => {
  test("text-only response with no tool calls → stopReason done", async () => {
    global.fetch = mock(async () =>
      makeSSEResponse([
        JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
        JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        "[DONE]",
      ])
    );

    const agent = new CursorAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.output).toBe("Hello");
    expect(result.stopReason).toBe("done");
    expect(result.turns).toHaveLength(1);
  });

  test("one tool call turn followed by text → executeTool called, stopReason done", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return makeSSEResponse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "read_file", arguments: "" } }] } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp/f"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
          "[DONE]",
        ]);
      }
      return makeSSEResponse([
        JSON.stringify({ choices: [{ delta: { content: "Done" } }] }),
        JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        "[DONE]",
      ]);
    });

    const agent = new CursorAgent();
    const result = await agent.run(baseRunOpts());

    expect(executeToolMock).toHaveBeenCalledWith(
      "read_file",
      { path: "/tmp/f" },
      "/tmp",
      undefined,
    );
    expect(result.turns).toHaveLength(2);
    expect(result.stopReason).toBe("done");
  });

  test("HTTP 500 → stopReason error, error contains status code", async () => {
    global.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 })
    );

    const agent = new CursorAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("500");
  });

  test("network-level fetch throws → stopReason error, error message propagated", async () => {
    global.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });

    const agent = new CursorAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("ECONNREFUSED");
  });
});
