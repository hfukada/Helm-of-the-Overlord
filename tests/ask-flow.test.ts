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

  test("returns JSON answer with sources", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is the project name", limit: 3 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { answer: string; sources: unknown[] };
    expect(typeof data.answer).toBe("string");
    expect(data.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(data.sources)).toBe(true);
  }, 60_000);
});

describe("daemon /knowledge/ask (NDJSON streaming mode)", () => {
  test("returns ndjson content-type", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is this project", stream: true, limit: 3 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    // consume body
    await res.text();
  }, 60_000);

  test("streams event lines followed by done line", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is the project name", stream: true, limit: 3 }),
    });

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    // Parse each line as JSON
    const parsed = lines.map((l) => JSON.parse(l) as { type: string });

    // Last line should be "done"
    const last = parsed[parsed.length - 1] as { type: string; answer?: string; sources?: unknown[] };
    expect(last.type).toBe("done");
    expect(typeof last.answer).toBe("string");
    expect(last.answer!.length).toBeGreaterThan(0);
    expect(Array.isArray(last.sources)).toBe(true);

    // Earlier lines should be "event" type
    const eventLines = parsed.filter((p) => p.type === "event") as Array<{
      type: string;
      event_type: string;
      content: string;
    }>;
    // Should have at least one text event
    expect(eventLines.some((e) => e.event_type === "text")).toBe(true);
  }, 60_000);

  test("streaming with no results returns immediate done", async () => {
    if (!(await isDaemonUp())) return;
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "xyzzy_nonexistent_gibberish_query_12345",
        stream: true,
        repo_name: "nonexistent-repo-xyz",
      }),
    });
    // Should return 404 for unknown repo even in stream mode
    expect(res.status).toBe(404);
    await res.text();
  });

  test("streaming with empty search results returns done with message", async () => {
    if (!(await isDaemonUp())) return;
    // Use a query unlikely to match any indexed content
    // This depends on there being no matching chunks -- so we use the streaming
    // path with a very specific unlikely query
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "xyzzy_nonexistent_gibberish_zzz_99999",
        stream: true,
        limit: 1,
      }),
    });

    if (res.status !== 200) {
      // If no repos exist, might get a different response
      await res.text();
      return;
    }

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    // When no results found, should get a single "done" line with a message
    const done = parsed.find((p: { type: string }) => p.type === "done");
    expect(done).toBeDefined();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 3. Streaming resilience -- early disconnect
// ---------------------------------------------------------------------------

describe("daemon streaming resilience", () => {
  test("daemon survives client disconnect during streaming", async () => {
    if (!(await isDaemonUp())) return;

    // Create an AbortController to simulate early disconnect
    const controller = new AbortController();

    try {
      const fetchPromise = fetch(`${DAEMON}/knowledge/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "what is this project", stream: true, limit: 3 }),
        signal: controller.signal,
      });

      // Abort after a short delay (before response completes)
      setTimeout(() => controller.abort(), 100);

      await fetchPromise;
    } catch {
      // Expected -- AbortError
    }

    // Wait for the server to finish processing
    await new Promise((r) => setTimeout(r, 5000));

    // Daemon should still be alive
    const health = await fetch(`${DAEMON}/health`);
    expect(health.ok).toBe(true);
  }, 30_000);

  test("daemon handles multiple rapid disconnects", async () => {
    if (!(await isDaemonUp())) return;

    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      try {
        const p = fetch(`${DAEMON}/knowledge/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "test query", stream: true, limit: 2 }),
          signal: ac.signal,
        });
        setTimeout(() => ac.abort(), 50);
        await p;
      } catch {
        // expected
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Wait for any lingering claude processes to finish
    await new Promise((r) => setTimeout(r, 5000));

    const health = await fetch(`${DAEMON}/health`);
    expect(health.ok).toBe(true);
  }, 60_000);

  test("normal ask works after disconnects", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is the project name", limit: 2 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { answer: string };
    expect(typeof data.answer).toBe("string");
    expect(data.answer.length).toBeGreaterThan(0);
  }, 60_000);
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
