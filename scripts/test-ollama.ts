// Usage: bun run scripts/test-ollama.ts
// Required env vars: OLLAMA_HOST (default http://127.0.0.1:11434), OLLAMA_MODEL (default minimax.m2)
// Set HOTO_WORKSPACE to a temp path to avoid writing to the production DB.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOTO_WORKSPACE = join(tmpdir(), `hoto-smoke-${Date.now()}`);

import { OllamaAgent } from "../src/agent/ollama";
import type { AgentRunOptions, AgentEvent, ToolDefinition } from "../src/agent/types";

const readTool: ToolDefinition = {
  name: "Read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to read" },
    },
    required: ["file_path"],
  },
};

const events: AgentEvent[] = [];

const agent = new OllamaAgent({
  model: process.env.OLLAMA_MODEL ?? "minimax.m2",
});

const opts: AgentRunOptions = {
  prompt: "Read the file package.json and tell me the name field.",
  systemPrompt: "You are a test agent. Use the tools provided.",
  tools: [readTool],
  maxTurns: 5,
  workDir: process.cwd(),
  agentRunId: `smoke-test-${Date.now()}`,
  onEvent: (e: AgentEvent) => events.push(e),
};

try {
  const result = await agent.run(opts);

  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  }

  assert(result.stopReason !== "error", `agent returned stopReason "error"`);
  assert(result.turns.length >= 1, `expected at least 1 turn, got ${result.turns.length}`);
  assert(typeof result.output === "string" && result.output.length > 0, "result.output is empty");

  console.log("smoke test passed");
  process.exit(0);
} catch (err) {
  console.error("smoke test failed:", err);
  process.exit(1);
}
