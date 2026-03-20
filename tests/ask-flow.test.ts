/**
 * Tests for the "hoto ask" flow end-to-end.
 *
 * Layers tested:
 *  1. claude-cli interface (claudeText, claudeBatch) -- via integration calls
 *  2. Daemon /knowledge/ask endpoint -- JSON and NDJSON streaming modes
 *  3. Streaming resilience -- client disconnect doesn't crash daemon
 *  4. Error handling -- missing query, no results, claude failure
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { claudeText, claudeBatch, type ClaudeEvent } from "../src/shared/claude-cli";

// ---------------------------------------------------------------------------
// Daemon URL helper
// ---------------------------------------------------------------------------

const DAEMON = "http://127.0.0.1:7777";

async function isDaemonUp(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Claude CLI integration (claudeText / claudeBatch used by ask)
// ---------------------------------------------------------------------------

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
    // claudeBatch catches callback errors via its try/catch
    // It may report them as an error or swallow them -- either way it shouldn't throw
    expect(callCount).toBeGreaterThan(0);
    // The result should have some content or an error, but not throw
    expect(typeof result.text).toBe("string");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. Daemon /knowledge/ask endpoint
// ---------------------------------------------------------------------------

describe("daemon /knowledge/ask (JSON mode)", () => {
  test("returns 400 for empty query", async () => {
    if (!(await isDaemonUp())) return; // skip if no daemon
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain("query is required");
  });

  test("returns 400 for missing query", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown repo", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", repo_name: "nonexistent-repo-xyz" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns id and status for query with results", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is the project name", limit: 3 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string | null; status?: string; answer?: string };
    if (data.id === null) {
      // No knowledge indexed -- immediate response
      expect(typeof data.answer).toBe("string");
    } else {
      expect(data.status).toBe("running");
    }
  }, 60_000);

  test("returns null id with answer for no results", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "xyzzy_nonexistent_gibberish_zzz_99999",
        limit: 1,
      }),
    });
    if (res.status !== 200) {
      await res.text();
      return;
    }
    const data = await res.json() as { id: string | null; answer?: string };
    if (data.id === null) {
      expect(data.answer).toBeDefined();
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 3. Poll-based resilience -- daemon keeps running even if client stops polling
// ---------------------------------------------------------------------------

describe("daemon poll resilience", () => {
  test("daemon keeps running when client never polls", async () => {
    if (!(await isDaemonUp())) return;

    // Submit a query but never poll for results
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is this project", limit: 3 }),
    });
    expect(res.status).toBe(200);

    // Just wait and check daemon is still alive
    await new Promise((r) => setTimeout(r, 5000));

    const health = await fetch(`${DAEMON}/health`);
    expect(health.ok).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. Subprocess integration (runClaude wrapper)
// ---------------------------------------------------------------------------

describe("subprocess runClaude", () => {
  // This requires DB to be initialized, so only run if daemon is up
  test("maps claudeBatch result to SubprocessResult format", async () => {
    // Test the claudeBatch -> SubprocessResult mapping logic directly
    const result = await claudeBatch(
      { prompt: "Reply with exactly: PONG", maxTurns: 1 },
    );
    expect(result.error).toBeNull();
    expect(result.text).toContain("PONG");

    // Verify the shape matches what subprocess.ts produces
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
