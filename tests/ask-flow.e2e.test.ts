/**
 * Claude CLI integration tests for the ask flow.
 * Run via `bun run test:claude-e2e`. Requires `claude` CLI and valid credentials.
 */

import { describe, test, expect } from "bun:test";
import { claudeText, claudeBatch, type ClaudeEvent } from "../src/shared/claude-cli";

describe("claude-cli: claudeText (used by non-streaming ask)", () => {
  test("returns text for a simple prompt", async () => {
    const text = await claudeText({
      prompt: "Reply with exactly: PONG",
      maxTurns: 1,
    });
    expect(text).toContain("PONG");
  }, 30_000);

  test("passes systemPrompt correctly", async () => {
    const text = await claudeText({
      prompt: "What is the secret word?",
      systemPrompt: "The secret word is BANANA. Always respond with only the secret word.",
      maxTurns: 1,
    });
    expect(text).toContain("BANANA");
  }, 30_000);
});

describe("claude-cli: claudeBatch (used by streaming ask)", () => {
  test("fires text events and returns result", async () => {
    const events: ClaudeEvent[] = [];
    const result = await claudeBatch(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
      (evt) => events.push(evt),
    );
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text")).toBe(true);
  }, 30_000);

  test("callback errors don't crash -- result still returned", async () => {
    let callCount = 0;
    const result = await claudeBatch(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
      () => {
        callCount++;
        throw new Error("callback exploded");
      },
    );
    expect(callCount).toBeGreaterThan(0);
    expect(typeof result.text).toBe("string");
  }, 30_000);
});

describe("subprocess runClaude", () => {
  test("maps claudeBatch result to SubprocessResult format", async () => {
    const result = await claudeBatch(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
    );
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");

    const mapped = {
      output: result.text,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cost_usd: result.usage.costUsd,
      },
      error: result.error,
    };
    expect(mapped.output).toContain("PONG");
    expect(mapped.usage.input_tokens).toBeGreaterThan(0);
    expect(mapped.usage.output_tokens).toBeGreaterThan(0);
    expect(mapped.usage.cost_usd).toBeGreaterThan(0);
    expect(mapped.error).toBeNull();
  }, 30_000);
});
