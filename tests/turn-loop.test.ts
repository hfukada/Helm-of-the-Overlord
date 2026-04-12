import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// MUST set env before any other imports
const tmpDir = join("/tmp", `hoto-turn-loop-test-${Date.now()}`);
process.env.HOTO_WORKSPACE = tmpDir;
process.env.HOTO_LOG_LEVEL = "warn";
mkdirSync(tmpDir, { recursive: true });

import { describe, test, expect, mock, afterAll } from "bun:test";
import { ulid } from "ulid";

// Track claudeStream calls for assertions
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

// Mock claude-cli before importing turn-loop
mock.module("../src/shared/claude-cli", () => ({
  claudeStream: async (
    opts: Record<string, unknown>,
    onEvent: (evt: { type: string; content: string }) => void,
  ) => {
    claudeStreamCalls.push({ opts, callback: onEvent });

    const behavior = mockTurnBehaviors[turnIndex] ?? { toolCalls: [], text: "done", error: null };
    turnIndex++;

    // Simulate tool use events
    for (const tool of behavior.toolCalls) {
      onEvent({ type: "tool_use", content: `Tool: ${tool}` });
    }

    // Simulate text output
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

// Mock logger
mock.module("../src/shared/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Mock knowledge/db with an in-memory SQLite database
import { Database } from "bun:sqlite";
const testDb = new Database(":memory:");
testDb.exec("PRAGMA journal_mode = WAL");
testDb.exec("PRAGMA foreign_keys = ON");
testDb.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  prompt TEXT NOT NULL,
  output TEXT,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT,
  child_task_id TEXT,
  session_id TEXT
)`);
testDb.exec(`CREATE TABLE IF NOT EXISTS agent_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  has_tool_use INTEGER NOT NULL DEFAULT 0,
  tool_names TEXT,
  text_output TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

mock.module("../src/knowledge/db", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

import { runTurnLoop } from "../src/orchestrator/turn-loop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

afterAll(() => {
  testDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurnLoop", () => {
  test("completes in one turn when no tool use", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: [], text: "Here is the plan." },
    ];

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
    // All turns use tools -- will hit max
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

    // First call should have sessionId, no resumeId
    const firstOpts = claudeStreamCalls[0].opts;
    expect(firstOpts.sessionId).toBeDefined();
    expect(firstOpts.resumeId).toBeUndefined();

    // Second call should have resumeId, no sessionId
    const secondOpts = claudeStreamCalls[1].opts;
    expect(secondOpts.resumeId).toBeDefined();
    expect(secondOpts.sessionId).toBeUndefined();

    // Same UUID
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

    // Each turn returns 100 input, 50 output, 0.01 cost
    expect(result.totalUsage.input_tokens).toBe(300);
    expect(result.totalUsage.output_tokens).toBe(150);
    expect(result.totalUsage.cost_usd).toBeCloseTo(0.03);
  });

  test("shouldStop hook can end the loop early", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read"], text: "" },
      { toolCalls: ["Read"], text: "" },
      { toolCalls: ["Read"], text: "" },
    ];

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
      onTurnComplete: async (_turn) => "Please also check the tests.",
    });

    // Second call should use the injected message instead of "continue"
    expect(claudeStreamCalls[1].opts.prompt).toBe("Please also check the tests.");
  });

  test("handles error from claude", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: [], text: "", error: "authentication failed" },
    ];

    const result = await runTurnLoop(baseOpts());

    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("authentication failed");
    expect(result.turns).toHaveLength(1);
  });

  test("logs turns to agent_turns table", async () => {
    resetMocks();
    const agentRunId = ulid();
    mockTurnBehaviors = [
      { toolCalls: ["Read", "Glob"], text: "" },
      { toolCalls: [], text: "result text" },
    ];

    // Need an agent_run row to reference
    testDb.run(
      "INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model) VALUES (?, 'test-task', 'test', 'agentic', 'running', 'test', 'test-model')",
      [agentRunId],
    );

    await runTurnLoop({ ...baseOpts(), agentRunId });

    const turns = testDb.query(
      "SELECT * FROM agent_turns WHERE agent_run_id = ? ORDER BY turn_number",
    ).all(agentRunId) as Array<Record<string, unknown>>;

    expect(turns).toHaveLength(2);
    expect(turns[0].turn_number).toBe(1);
    expect(turns[0].has_tool_use).toBe(1);
    expect(JSON.parse(turns[0].tool_names as string)).toContain("Read");
    expect(JSON.parse(turns[0].tool_names as string)).toContain("Glob");
    expect(turns[1].turn_number).toBe(2);
    expect(turns[1].has_tool_use).toBe(0);
    expect(turns[1].text_output).toContain("result text");
  });

  test("deduplicates tool names within a turn", async () => {
    resetMocks();
    mockTurnBehaviors = [
      { toolCalls: ["Read", "Read", "Read"], text: "" },
      { toolCalls: [], text: "done" },
    ];

    const result = await runTurnLoop(baseOpts());

    // The turn should only have "Read" once (deduped by the event handler)
    expect(result.turns[0].toolCalls).toEqual(["Read"]);
  });
});
