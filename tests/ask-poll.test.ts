/**
 * Tests for the poll-based ask flow.
 *
 * Layers tested:
 *  1. DB storage: ask_queries and ask_stream tables
 *  2. Poll endpoint: cursor pagination via ?after=N
 *  3. Status transitions: running -> completed, running -> failed
 *  4. Immediate return when no knowledge found (id is null)
 *  5. StreamFormatter tool_result truncation
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/knowledge/schema";
import { StreamFormatter, truncateToolResult, type FormatterOutput } from "../src/cli/stream-formatter";

// ---------------------------------------------------------------------------
// 1. DB storage tests (in-memory SQLite)
// ---------------------------------------------------------------------------

describe("ask poll: DB storage", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterAll(() => {
    db.close();
  });

  test("ask_queries table exists and accepts records", () => {
    db.query(
      "INSERT INTO ask_queries (id, query, status) VALUES ('ask-1', 'what is this', 'running')"
    ).run();

    const row = db.query("SELECT * FROM ask_queries WHERE id = 'ask-1'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.query).toBe("what is this");
    expect(row.status).toBe("running");
    expect(row.answer).toBeNull();
    expect(row.created_at).toBeDefined();
  });

  test("ask_stream table stores events with autoincrement IDs", () => {
    db.query(
      "INSERT INTO ask_stream (ask_query_id, event_type, content) VALUES ('ask-1', 'thinking', 'pondering...')"
    ).run();
    db.query(
      "INSERT INTO ask_stream (ask_query_id, event_type, content) VALUES ('ask-1', 'text', 'The answer is 42')"
    ).run();

    const events = db.query(
      "SELECT * FROM ask_stream WHERE ask_query_id = 'ask-1' ORDER BY id"
    ).all() as Array<{ id: number; event_type: string; content: string }>;

    expect(events.length).toBe(2);
    expect(events[0].id).toBeLessThan(events[1].id);
    expect(events[0].event_type).toBe("thinking");
    expect(events[1].event_type).toBe("text");
  });

  test("cursor pagination with after param", () => {
    // Insert more events
    db.query(
      "INSERT INTO ask_stream (ask_query_id, event_type, content) VALUES ('ask-1', 'text', 'more text')"
    ).run();

    const allEvents = db.query(
      "SELECT * FROM ask_stream WHERE ask_query_id = 'ask-1' ORDER BY id"
    ).all() as Array<{ id: number }>;

    // Query with after = first event ID
    const afterFirst = db.query(
      "SELECT * FROM ask_stream WHERE ask_query_id = 'ask-1' AND id > ? ORDER BY id LIMIT 200"
    ).all(allEvents[0].id) as Array<{ id: number }>;

    expect(afterFirst.length).toBe(allEvents.length - 1);
    expect(afterFirst[0].id).toBe(allEvents[1].id);
  });

  test("status transitions: running -> completed", () => {
    db.query(
      "UPDATE ask_queries SET status = 'completed', answer = 'The answer', sources = '[]', finished_at = datetime('now') WHERE id = 'ask-1'"
    ).run();

    const row = db.query("SELECT * FROM ask_queries WHERE id = 'ask-1'").get() as Record<string, unknown>;
    expect(row.status).toBe("completed");
    expect(row.answer).toBe("The answer");
    expect(row.finished_at).toBeDefined();
  });

  test("status transitions: running -> failed", () => {
    db.query(
      "INSERT INTO ask_queries (id, query, status) VALUES ('ask-2', 'will fail', 'running')"
    ).run();
    db.query(
      "UPDATE ask_queries SET status = 'failed', error = 'Claude exploded', finished_at = datetime('now') WHERE id = 'ask-2'"
    ).run();

    const row = db.query("SELECT * FROM ask_queries WHERE id = 'ask-2'").get() as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Claude exploded");
  });
});

// ---------------------------------------------------------------------------
// 2. Daemon endpoint tests (require running daemon)
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

describe("ask poll: daemon endpoints", () => {
  test("POST /knowledge/ask returns id and status for valid query", async () => {
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
      expect(data.answer).toBeDefined();
    } else {
      expect(data.status).toBe("running");
      expect(typeof data.id).toBe("string");
    }
  });

  test("POST /knowledge/ask returns null id for no results", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "xyzzy_nonexistent_gibberish_99999", limit: 1 }),
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { id: string | null; answer?: string };
    // If no indexed repos at all, search might still return nothing
    if (data.id === null) {
      expect(data.answer).toBeDefined();
    }
  });

  test("POST /knowledge/ask returns 400 for empty query", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /knowledge/ask/:id/stream returns 404 for unknown ID", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask/nonexistent-id/stream`);
    expect(res.status).toBe(404);
  });

  test("GET /knowledge/ask/:id/stream returns events with cursor", async () => {
    if (!(await isDaemonUp())) return;

    // Submit a query first
    const submitRes = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is the project name", limit: 3 }),
    });
    const submitData = await submitRes.json() as { id: string | null };

    if (!submitData.id) return; // no knowledge indexed

    // Poll until done (with timeout)
    const askId = submitData.id;
    let lastSeenId = 0;
    let totalEvents = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < 60_000) {
      const pollRes = await fetch(`${DAEMON}/knowledge/ask/${askId}/stream?after=${lastSeenId}`);
      expect(pollRes.status).toBe(200);

      const poll = await pollRes.json() as {
        status: string;
        events: Array<{ id: number; event_type: string; content: string }>;
        answer?: string;
        error?: string;
      };

      totalEvents += poll.events.length;
      if (poll.events.length > 0) {
        lastSeenId = poll.events[poll.events.length - 1].id;
      }

      if (poll.status === "completed") {
        expect(poll.answer).toBeDefined();
        expect(typeof poll.answer).toBe("string");
        break;
      }

      if (poll.status === "failed") {
        // Acceptable -- Claude might fail in test env
        expect(poll.error).toBeDefined();
        break;
      }

      await Bun.sleep(200);
    }

    expect(totalEvents).toBeGreaterThan(0);
  }, 90_000);

  test("poll with after=0 returns all events, after=N skips earlier ones", async () => {
    if (!(await isDaemonUp())) return;

    // Submit and wait for completion
    const submitRes = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is this project about", limit: 2 }),
    });
    const submitData = await submitRes.json() as { id: string | null };
    if (!submitData.id) return;

    const askId = submitData.id;
    const startTime = Date.now();

    // Wait for completion
    while (Date.now() - startTime < 60_000) {
      const pollRes = await fetch(`${DAEMON}/knowledge/ask/${askId}/stream?after=0`);
      const poll = await pollRes.json() as { status: string; events: Array<{ id: number }> };
      if (poll.status !== "running") {
        // Now test cursor: get all events first
        const allRes = await fetch(`${DAEMON}/knowledge/ask/${askId}/stream?after=0`);
        const allPoll = await allRes.json() as { events: Array<{ id: number }> };

        if (allPoll.events.length >= 2) {
          const midId = allPoll.events[Math.floor(allPoll.events.length / 2)].id;
          const partialRes = await fetch(`${DAEMON}/knowledge/ask/${askId}/stream?after=${midId}`);
          const partialPoll = await partialRes.json() as { events: Array<{ id: number }> };

          expect(partialPoll.events.length).toBeLessThan(allPoll.events.length);
          if (partialPoll.events.length > 0) {
            expect(partialPoll.events[0].id).toBeGreaterThan(midId);
          }
        }
        break;
      }
      await Bun.sleep(200);
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 3. StreamFormatter tool_result truncation
// ---------------------------------------------------------------------------

describe("ask poll: tool_result truncation", () => {
  test("short content passes through unchanged", () => {
    const result = truncateToolResult("Found 3 files");
    expect(result).toBe("Found 3 files");
  });

  test("content at 150 chars passes through", () => {
    const content = "x".repeat(150);
    expect(truncateToolResult(content)).toBe(content);
  });

  test("long single-line content truncates with char count", () => {
    const content = "x".repeat(300);
    const result = truncateToolResult(content);
    expect(result).toContain("(300 chars)");
    expect(result.length).toBeLessThan(300);
  });

  test("multi-line content shows first line + char count", () => {
    const content = "first line here\nsecond line\nthird line with lots of data " + "x".repeat(200);
    const result = truncateToolResult(content);
    expect(result).toContain("first line here");
    expect(result).not.toContain("second line");
    expect(result).toContain("chars)");
  });

  test("StreamFormatter uses truncation for tool_result events", () => {
    const output: FormatterOutput[] = [];
    const fmt = new StreamFormatter(true, (o) => output.push(o));

    const longContent = "README.md\npackage.json\nsrc/index.ts\n" + "x".repeat(200);
    fmt.push("tool_result", longContent);
    fmt.flush();

    expect(output.length).toBe(1);
    expect(output[0].type).toBe("result");
    expect(output[0].content).toContain("README.md");
    expect(output[0].content).toContain("chars)");
  });
});
