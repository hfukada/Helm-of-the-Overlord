import { describe, test, expect, mock, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";

// ---------------------------------------------------------------------------
// Mocks (must be before importing the agent)
// ---------------------------------------------------------------------------

let claudeStreamCalls: Array<{
  opts: Record<string, unknown>;
  callback: (evt: { type: string; content: string }) => void;
}> = [];

let turnIndex = 0;
let mockTurnBehaviors: Array<{
  toolCalls: string[];
  text: string;
  error?: string | null;
}> = [];

// Preserve all original exports and override claudeStream only.
// Bun's mock.module replaces the module globally for the test run, so any
// other test files that import from claude-cli would lose their exports
// unless we re-export them from the real module here.
const _realClaudeCli = await import("../src/shared/claude-cli");
mock.module("../src/shared/claude-cli", () => ({
  ..._realClaudeCli,
  claudeStream: async (
    opts: Record<string, unknown>,
    onEvent: (evt: { type: string; content: string }) => void,
  ) => {
    claudeStreamCalls.push({ opts, callback: onEvent });
    const behavior = mockTurnBehaviors[turnIndex] ?? { toolCalls: [], text: "done", error: null };
    turnIndex++;

    for (const tool of behavior.toolCalls) {
      onEvent({ type: "tool_use", content: `Tool: ${tool}` });
    }
    if (behavior.text) {
      onEvent({ type: "text", content: behavior.text });
    }

    return {
      text: behavior.text,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      error: behavior.toolCalls.length > 0
        ? "claude reached max turns limit (agent may not have finished all work)"
        : (behavior.error ?? null),
    };
  },
}));

mock.module("../src/shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Import AFTER mocks. knowledge/db is NOT mocked -- the agent wraps DB calls
// in try/catch so they'll log warnings but not crash.
const { ClaudeCodeCliAgent } = await import("../src/agent/claude-code-cli");
const { READ, READ_TOOLS, EDIT_TOOLS, SEARCH_KNOWLEDGE, withKnowledgeSearch } = await import("../src/agent/tools");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = join("/tmp", `hoto-agent-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

function resetMocks() {
  claudeStreamCalls = [];
  turnIndex = 0;
  mockTurnBehaviors = [];
}

function baseRunOpts() {
  return {
    prompt: "test prompt",
    systemPrompt: "test system",
    workDir: tmpDir,
    maxTurns: 10,
    tools: READ_TOOLS,
    agentRunId: ulid(),
  };
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ClaudeCodeCliAgent behavior
// ---------------------------------------------------------------------------

describe("ClaudeCodeCliAgent", () => {
  test("completes in one turn when no tool use", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "Here is the plan." }];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.stopReason).toBe("done");
    expect(result.turns).toHaveLength(1);
    expect(result.output).toContain("Here is the plan.");
    expect(result.error).toBeNull();
  });

  test("continues when tool use is detected", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: ["Edit"], text: "" },
      { toolCalls: [], text: "Done editing files." },
    ];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.stopReason).toBe("done");
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0].hasToolUse).toBe(true);
    expect(result.turns[0].toolCalls.map((t) => t.name)).toContain("Read");
    expect(result.turns[1].hasToolUse).toBe(true);
    expect(result.turns[2].hasToolUse).toBe(false);
  });

  test("stops at max turns", async () => {
    resetMocks();
    mockTurnBehaviors = Array(5).fill({ toolCalls: ["Read"], text: "" });

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run({ ...baseRunOpts(), maxTurns: 3 });

    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toHaveLength(3);
  });

  test("first turn uses sessionId, subsequent turns use resumeId", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(claudeStreamCalls).toHaveLength(2);
    const firstOpts = claudeStreamCalls[0].opts;
    const secondOpts = claudeStreamCalls[1].opts;
    expect(firstOpts.sessionId).toBeDefined();
    expect(firstOpts.resumeId).toBeUndefined();
    expect(secondOpts.resumeId).toBeDefined();
    expect(secondOpts.sessionId).toBeUndefined();
    expect(firstOpts.sessionId).toBe(secondOpts.resumeId);
    expect(result.metadata?.sessionId).toBe(firstOpts.sessionId);
  });

  test("first turn sends the prompt, subsequent turns send 'continue'", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const agent = new ClaudeCodeCliAgent();
    await agent.run(baseRunOpts());

    expect(claudeStreamCalls[0].opts.prompt).toBe("test prompt");
    expect(claudeStreamCalls[1].opts.prompt).toBe("continue");
  });

  test("system prompt only sent on first turn", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const agent = new ClaudeCodeCliAgent();
    await agent.run(baseRunOpts());

    expect(claudeStreamCalls[0].opts.systemPrompt).toBe("test system");
    expect(claudeStreamCalls[1].opts.systemPrompt).toBeUndefined();
  });

  test("accumulates total usage across turns", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: ["Edit"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.totalUsage.input_tokens).toBe(300);
    expect(result.totalUsage.output_tokens).toBe(150);
    expect(result.totalUsage.cost_usd).toBeCloseTo(0.03);
  });

  test("shouldStop hook can end the loop early", async () => {
    resetMocks();
    mockTurnBehaviors = Array(3).fill({ toolCalls: ["Read"], text: "" });

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run({
      ...baseRunOpts(),
      shouldStop: (turn) => turn.turnNumber >= 2,
    });

    expect(result.stopReason).toBe("cancelled");
    expect(result.turns).toHaveLength(2);
  });

  test("onTurnComplete can inject a custom message", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "fixed it" },
    ];

    const agent = new ClaudeCodeCliAgent();
    await agent.run({
      ...baseRunOpts(),
      onTurnComplete: async () => "Please also check the tests.",
    });

    expect(claudeStreamCalls[1].opts.prompt).toBe("Please also check the tests.");
  });

  test("handles error from claude", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "", error: "authentication failed" }];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("authentication failed");
    expect(result.turns).toHaveLength(1);
  });

  test("returns per-turn results with tool and text data", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read", "Glob"], text: "" },
      { toolCalls: [], text: "result text" },
    ];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].turnNumber).toBe(1);
    expect(result.turns[0].hasToolUse).toBe(true);
    const toolNames0 = result.turns[0].toolCalls.map((t) => t.name);
    expect(toolNames0).toContain("Read");
    expect(toolNames0).toContain("Glob");
    expect(result.turns[1].turnNumber).toBe(2);
    expect(result.turns[1].hasToolUse).toBe(false);
    expect(result.turns[1].text).toContain("result text");
  });

  test("deduplicates tool names within a turn", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read", "Read", "Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const agent = new ClaudeCodeCliAgent();
    const result = await agent.run(baseRunOpts());

    expect(result.turns[0].toolCalls.map((t) => t.name)).toEqual(["Read"]);
  });
});

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

describe("ClaudeCodeCliAgent tool translation", () => {
  test("translates generic ToolDefinitions to Claude CLI allowedTools", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "done" }];

    const agent = new ClaudeCodeCliAgent();
    await agent.run({ ...baseRunOpts(), tools: READ_TOOLS });

    const allowedTools = claudeStreamCalls[0].opts.allowedTools as string[];
    expect(allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("uses claudeCliPattern from providerHints when present", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "done" }];

    const agent = new ClaudeCodeCliAgent();
    await agent.run({ ...baseRunOpts(), tools: [SEARCH_KNOWLEDGE, READ] });

    const allowedTools = claudeStreamCalls[0].opts.allowedTools as string[];
    expect(allowedTools).toContain("mcp__hoto__search_knowledge");
    expect(allowedTools).toContain("Read");
  });

  test("withKnowledgeSearch prepends the search tool", () => {
    const tools = withKnowledgeSearch(READ_TOOLS);
    expect(tools[0].name).toBe("SearchKnowledge");
    expect(tools).toHaveLength(READ_TOOLS.length + 1);
  });

  test("withKnowledgeSearch is idempotent", () => {
    const once = withKnowledgeSearch(READ_TOOLS);
    const twice = withKnowledgeSearch(once);
    expect(twice).toHaveLength(once.length);
  });

  test("EDIT_TOOLS includes Read plus Write/Edit/Bash", () => {
    const names = EDIT_TOOLS.map((t) => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("Bash");
  });
});

// ---------------------------------------------------------------------------
// Sandbox forwarding
// ---------------------------------------------------------------------------

describe("ClaudeCodeCliAgent sandbox", () => {
  test("passes containerName/containerWorkDir when sandbox is provided", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "done" }];

    const agent = new ClaudeCodeCliAgent({
      sandbox: { containerName: "hoto-abc", containerWorkDir: "/data/abc" },
    });
    await agent.run(baseRunOpts());

    expect(claudeStreamCalls[0].opts.containerName).toBe("hoto-abc");
    expect(claudeStreamCalls[0].opts.containerWorkDir).toBe("/data/abc");
    expect(claudeStreamCalls[0].opts.cwd).toBeUndefined();
  });

  test("passes cwd (not containerName) when no sandbox", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "done" }];

    const agent = new ClaudeCodeCliAgent();
    await agent.run(baseRunOpts());

    expect(claudeStreamCalls[0].opts.containerName).toBeUndefined();
    expect(claudeStreamCalls[0].opts.cwd).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Event translation (AgentEvent)
// ---------------------------------------------------------------------------

describe("ClaudeCodeCliAgent events", () => {
  test("emits AgentEvent objects with turnNumber", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "thinking text" },
      { toolCalls: [], text: "done" },
    ];

    const events: Array<{ type: string; turnNumber: number }> = [];
    const agent = new ClaudeCodeCliAgent();
    await agent.run({
      ...baseRunOpts(),
      onEvent: (e) => events.push({ type: e.type, turnNumber: e.turnNumber }),
    });

    // Should have at least text + tool_call events from turn 1, and done from turn 2
    const turn1Events = events.filter((e) => e.turnNumber === 1);
    const turn2Events = events.filter((e) => e.turnNumber === 2);
    expect(turn1Events.length).toBeGreaterThan(0);
    expect(turn2Events.length).toBeGreaterThan(0);

    // tool_use from claude-cli becomes tool_call in AgentEvent
    const hasToolCall = events.some((e) => e.type === "tool_call");
    expect(hasToolCall).toBe(true);
  });
});
