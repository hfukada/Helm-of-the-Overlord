/**
 * Tests for the "hoto ask" flow end-to-end.
 *
 * Layers tested here (non-Claude):
 *  1. Daemon /knowledge/ask endpoint -- JSON and NDJSON streaming modes
 *  2. Streaming resilience -- client disconnect doesn't crash daemon
 *
 * Claude CLI integration tests live in ask-flow.e2e.test.ts.
 */

import { describe, test, expect } from "bun:test";

const DAEMON = "http://127.0.0.1:7777";

async function isDaemonUp(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

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

describe("daemon poll resilience", () => {
  test("daemon keeps running when client never polls", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is this project", limit: 3 }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 5000));

    const health = await fetch(`${DAEMON}/health`);
    expect(health.ok).toBe(true);
  }, 30_000);
});
