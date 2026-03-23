import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDb } from "../src/knowledge/db";
import { getRelationshipContext } from "../src/orchestrator/context-builder";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-rel-context";

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-rel-context", { recursive: true });
  getDb();
});

function seedRepos() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM repo_relationships");
  db.run("DELETE FROM repos");
  db.exec("PRAGMA foreign_keys = ON");

  db.run("INSERT INTO repos (id, name, path, language) VALUES (100, 'my-api', '/tmp/my-api', 'typescript')");
  db.run("INSERT INTO repos (id, name, path, language) VALUES (101, 'my-frontend', '/tmp/my-frontend', 'typescript')");
  db.run("INSERT INTO repos (id, name, path, language) VALUES (102, 'shared-lib', '/tmp/shared-lib', 'typescript')");
}

describe("getRelationshipContext", () => {
  beforeEach(() => {
    seedRepos();
  });

  test("returns empty string when no relationships exist", () => {
    const result = getRelationshipContext(100);
    expect(result).toBe("");
  });

  test("includes outgoing relationships", () => {
    const db = getDb();
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [100, 101, "depends_on", "API serves the frontend"]
    );

    const result = getRelationshipContext(100);
    expect(result).toContain("Related Repositories");
    expect(result).toContain("my-api -> my-frontend");
    expect(result).toContain("depends_on");
    expect(result).toContain("API serves the frontend");
  });

  test("includes incoming relationships", () => {
    const db = getDb();
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [102, 100, "dependency_of", "shared-lib is used by my-api"]
    );

    const result = getRelationshipContext(100);
    expect(result).toContain("shared-lib -> my-api");
    expect(result).toContain("shared-lib is used by my-api");
  });

  test("includes both directions", () => {
    const db = getDb();
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [100, 101, "serves", "API for frontend"]
    );
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [102, 100, "dependency_of", "shared types"]
    );

    const result = getRelationshipContext(100);
    expect(result).toContain("my-api -> my-frontend");
    expect(result).toContain("shared-lib -> my-api");
  });

  test("handles missing description gracefully", () => {
    const db = getDb();
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [100, 101, "related"]
    );

    const result = getRelationshipContext(100);
    expect(result).toContain("my-api -> my-frontend (related)");
    // No trailing colon when description is null
    expect(result).not.toContain(": null");
  });

  test("includes cross-repo planning hint", () => {
    const db = getDb();
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [100, 101, "related"]
    );

    const result = getRelationshipContext(100);
    expect(result).toContain("changes may need to span multiple repos");
  });

  test("returns empty for unknown repo ID", () => {
    const result = getRelationshipContext(99999);
    expect(result).toBe("");
  });
});
