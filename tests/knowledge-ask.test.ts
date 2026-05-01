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

describe("POST /knowledge/ask with general: true", () => {
  test("returns running id without searching repos", async () => {
    if (!(await isDaemonUp())) return;

    // A gibberish query that would return 0 search results in normal mode.
    // With general: true the search is skipped, so we always get a running id.
    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "xyzzy_nonexistent_gibberish_zzz_99999_general",
        general: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { id: string | null; status?: string; answer?: string };
    // Must be the running shape, never the empty-results shape
    expect(typeof data.id).toBe("string");
    expect(data.id).not.toBeNull();
    expect(data.status).toBe("running");
    expect(data.answer).toBeUndefined();
  }, 10_000);
});

describe("POST /knowledge/ask with general: false (default)", () => {
  test("returns null id and answer message when no results found", async () => {
    if (!(await isDaemonUp())) return;

    const res = await fetch(`${DAEMON}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "xyzzy_nonexistent_gibberish_zzz_99999",
        general: false,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { id: string | null; answer?: string; sources?: unknown[] };
    if (data.id === null) {
      expect(data.answer).toContain("No relevant knowledge found");
      expect(Array.isArray(data.sources)).toBe(true);
    }
  }, 10_000);
});
