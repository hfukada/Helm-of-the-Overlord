/**
 * Tests that API date fields are returned in ISO 8601 format.
 *
 * Verifies:
 *  1. sqliteToIso converts SQLite datetime strings to ISO 8601
 *  2. fixDates transforms specified fields on a row object
 *  3. fixDatesAll transforms fields across an array of rows
 *  4. Already-ISO strings and null values are left untouched
 *  5. Integration: task and agent_run rows from DB get proper ISO dates
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/knowledge/schema";
import { sqliteToIso, fixDates, fixDatesAll } from "../src/daemon/dates";

// ---------------------------------------------------------------------------
// 1. Unit tests for sqliteToIso
// ---------------------------------------------------------------------------

describe("sqliteToIso", () => {
  test("converts SQLite datetime to ISO 8601", () => {
    expect(sqliteToIso("2026-04-04 06:52:47")).toBe("2026-04-04T06:52:47Z");
  });

  test("leaves ISO string unchanged", () => {
    expect(sqliteToIso("2026-04-04T06:52:47Z")).toBe("2026-04-04T06:52:47Z");
  });

  test("leaves ISO string with milliseconds unchanged", () => {
    expect(sqliteToIso("2026-04-04T06:52:47.123Z")).toBe("2026-04-04T06:52:47.123Z");
  });

  test("returns null for null", () => {
    expect(sqliteToIso(null)).toBe(null);
  });

  test("returns null for undefined", () => {
    expect(sqliteToIso(undefined)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 2. Unit tests for fixDates / fixDatesAll
// ---------------------------------------------------------------------------

describe("fixDates", () => {
  test("transforms specified fields on a row", () => {
    const row = {
      id: "abc",
      created_at: "2026-04-04 06:52:47",
      updated_at: "2026-04-04 07:00:00",
      name: "test",
    };
    fixDates(row, "created_at", "updated_at");
    expect(row.created_at).toBe("2026-04-04T06:52:47Z");
    expect(row.updated_at).toBe("2026-04-04T07:00:00Z");
    expect(row.name).toBe("test");
  });

  test("skips null fields", () => {
    const row = { id: 1, finished_at: null as string | null };
    fixDates(row, "finished_at");
    expect(row.finished_at).toBe(null);
  });

  test("skips fields not present on the row", () => {
    const row = { id: 1, name: "test" };
    fixDates(row, "created_at"); // field doesn't exist
    expect(row).toEqual({ id: 1, name: "test" });
  });
});

describe("fixDatesAll", () => {
  test("transforms fields across an array of rows", () => {
    const rows = [
      { started_at: "2026-01-01 00:00:00", finished_at: "2026-01-01 01:00:00" },
      { started_at: "2026-02-01 12:30:00", finished_at: null as string | null },
    ];
    fixDatesAll(rows, "started_at", "finished_at");
    expect(rows[0].started_at).toBe("2026-01-01T00:00:00Z");
    expect(rows[0].finished_at).toBe("2026-01-01T01:00:00Z");
    expect(rows[1].started_at).toBe("2026-02-01T12:30:00Z");
    expect(rows[1].finished_at).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Integration: verify DB rows get transformed correctly
// ---------------------------------------------------------------------------

describe("ISO dates from DB rows", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterAll(() => {
    db.close();
  });

  test("task created_at/updated_at are transformed to ISO 8601", () => {
    db.run(
      "INSERT INTO tasks (id, title, description, status) VALUES ('t1', 'Test', 'desc', 'pending')"
    );

    const row = db.query("SELECT created_at, updated_at FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    fixDates(row, "created_at", "updated_at");

    // Should be ISO format with T and Z
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // Should be parseable by JS Date without NaN
    expect(new Date(row.created_at as string).getTime()).not.toBeNaN();
    expect(new Date(row.updated_at as string).getTime()).not.toBeNaN();
  });

  test("agent_run started_at/finished_at are transformed to ISO 8601", () => {
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
       VALUES ('r1', 't1', 'plan', 'agentic', 'completed', 'test prompt', 'test-model')`
    );
    db.run(
      "UPDATE agent_runs SET finished_at = datetime('now') WHERE id = 'r1'"
    );

    const row = db.query("SELECT started_at, finished_at FROM agent_runs WHERE id = 'r1'").get() as Record<string, unknown>;
    fixDates(row, "started_at", "finished_at");

    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    expect(new Date(row.started_at as string).getTime()).not.toBeNaN();
    expect(new Date(row.finished_at as string).getTime()).not.toBeNaN();
  });

  test("null finished_at stays null after fixDates", () => {
    db.run(
      `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model)
       VALUES ('r2', 't1', 'implement', 'agentic', 'running', 'test', 'test-model')`
    );

    const row = db.query("SELECT started_at, finished_at FROM agent_runs WHERE id = 'r2'").get() as Record<string, unknown>;
    fixDates(row, "started_at", "finished_at");

    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.finished_at).toBe(null);
  });
});
