import { describe, test, expect, mock, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";

// ---------------------------------------------------------------------------
// Mocks (must be before importing turn-loop)
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

mock.module("../src/shared/claude-cli", () => ({
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

// Import AFTER mocks -- knowledge/db is NOT mocked so other test files aren't affected.
// turn-loop.ts wraps DB calls in try/catch, so they'll just log warnings and continue.
const { runTurnLoop } = await import("../src/orchestrator/turn-loop");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = join("/tmp", `hoto-turn-loop-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

function resetMocks() {
  claudeStreamCalls = [];
  turnIndex = 0;
  mockTurnBehaviors = [];
}

function baseOpts() {
  return {
    prompt: "test prompt",
    systemPrompt: "test system",
    workDir: tmpDir,
    model: "test-model",
    maxTurns: 10,
    agentRunId: ulid(),
  };
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurnLoop", () => {
  test("completes in one turn when no tool use", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "Here is the plan." }];

    const result = await runTurnLoop(baseOpts());

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

    const result = await runTurnLoop(baseOpts());

    expect(result.stopReason).toBe("done");
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0].hasToolUse).toBe(true);
    expect(result.turns[0].toolCalls).toContain("Read");
    expect(result.turns[1].hasToolUse).toBe(true);
    expect(result.turns[2].hasToolUse).toBe(false);
  });

  test("stops at max turns", async () => {
    resetMocks();
    mockTurnBehaviors = Array(5).fill({ toolCalls: ["Read"], text: "" });

    const result = await runTurnLoop({ ...baseOpts(), maxTurns: 3 });

    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toHaveLength(3);
  });

  test("first turn uses sessionId, subsequent turns use resumeId", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const result = await runTurnLoop(baseOpts());

    expect(claudeStreamCalls).toHaveLength(2);
    const firstOpts = claudeStreamCalls[0].opts;
    const secondOpts = claudeStreamCalls[1].opts;
    expect(firstOpts.sessionId).toBeDefined();
    expect(firstOpts.resumeId).toBeUndefined();
    expect(secondOpts.resumeId).toBeDefined();
    expect(secondOpts.sessionId).toBeUndefined();
    expect(firstOpts.sessionId).toBe(secondOpts.resumeId);
    expect(result.sessionId).toBe(firstOpts.sessionId);
  });

  test("first turn sends the prompt, subsequent turns send 'continue'", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    await runTurnLoop(baseOpts());

    expect(claudeStreamCalls[0].opts.prompt).toBe("test prompt");
    expect(claudeStreamCalls[1].opts.prompt).toBe("continue");
  });

  test("system prompt only sent on first turn", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    await runTurnLoop(baseOpts());

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

    const result = await runTurnLoop(baseOpts());

    expect(result.totalUsage.input_tokens).toBe(300);
    expect(result.totalUsage.output_tokens).toBe(150);
    expect(result.totalUsage.cost_usd).toBeCloseTo(0.03);
  });

  test("shouldStop hook can end the loop early", async () => {
    resetMocks();
    mockTurnBehaviors = Array(3).fill({ toolCalls: ["Read"], text: "" });

    const result = await runTurnLoop({
      ...baseOpts(),
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

    await runTurnLoop({
      ...baseOpts(),
      onTurnComplete: async () => "Please also check the tests.",
    });

    expect(claudeStreamCalls[1].opts.prompt).toBe("Please also check the tests.");
  });

  test("handles error from claude", async () => {
    resetMocks();
    mockTurnBehaviors = [{ toolCalls: [], text: "", error: "authentication failed" }];

    const result = await runTurnLoop(baseOpts());

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

    const result = await runTurnLoop(baseOpts());

    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].turnNumber).toBe(1);
    expect(result.turns[0].hasToolUse).toBe(true);
    expect(result.turns[0].toolCalls).toContain("Read");
    expect(result.turns[0].toolCalls).toContain("Glob");
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

    const result = await runTurnLoop(baseOpts());

    expect(result.turns[0].toolCalls).toEqual(["Read"]);
  });
});
