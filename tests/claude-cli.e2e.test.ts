import { describe, test, expect } from "bun:test";
import {
  claudeText,
  claudeJSON,
  claudeBatch,
  claudeStream,
  type ClaudeEvent,
} from "../src/shared/claude-cli";

// Integration tests: actual Claude CLI invocation.
// Run via `bun run test:claude-e2e`. Requires `claude` CLI and valid credentials.

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
    expect(events.some((e) => e.type === "text")).toBe(true);
  }, 30_000);

  test("streams tool use events", async () => {
    const events: ClaudeEvent[] = [];
    const result = await claudeStream(
      {
        prompt: "Read the file package.json and tell me the project name",
        maxTurns: 2,
        allowedTools: ["Read"],
        cwd: process.cwd(),
      },
      (evt) => { events.push(evt); },
    );
    expect(result.error).toBeNull();
    expect(result.text.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "tool_use")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  }, 60_000);
});
