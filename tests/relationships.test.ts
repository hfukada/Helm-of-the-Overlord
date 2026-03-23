import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDb } from "../src/knowledge/db";

// Set workspace before importing anything that triggers DB init
process.env.HOTO_WORKSPACE = "/tmp/hoto-test-relationships";

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-relationships", { recursive: true });
  // Force DB init
  getDb();
});

function seedRepos() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM repo_relationships");
  db.run("DELETE FROM repos");
  db.exec("PRAGMA foreign_keys = ON");
  db.run(
    "INSERT INTO repos (name, path, language) VALUES (?, ?, ?)",
    ["repo-alpha", "/tmp/repo-alpha", "typescript"]
  );
  db.run(
    "INSERT INTO repos (name, path, language) VALUES (?, ?, ?)",
    ["repo-beta", "/tmp/repo-beta", "python"]
  );
  db.run(
    "INSERT INTO repos (name, path, language) VALUES (?, ?, ?)",
    ["repo-gamma", "/tmp/repo-gamma", "go"]
  );
}

function getRepoId(name: string): number {
  const db = getDb();
  const row = db.query("SELECT id FROM repos WHERE name = ?").get(name) as { id: number };
  return row.id;
}

describe("repo_relationships: DB operations", () => {
  beforeEach(() => {
    seedRepos();
  });

  test("insert and query a relationship", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");

    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [alphaId, betaId, "depends_on", "alpha consumes beta's API"]
    );

    const rows = db.query(
      `SELECT rr.*, s.name as source_name, t.name as target_name
       FROM repo_relationships rr
       JOIN repos s ON s.id = rr.source_repo_id
       JOIN repos t ON t.id = rr.target_repo_id
       WHERE rr.source_repo_id = ? OR rr.target_repo_id = ?`
    ).all(alphaId, alphaId) as Array<{
      source_name: string;
      target_name: string;
      relationship: string;
      description: string;
    }>;

    expect(rows.length).toBe(1);
    expect(rows[0].source_name).toBe("repo-alpha");
    expect(rows[0].target_name).toBe("repo-beta");
    expect(rows[0].relationship).toBe("depends_on");
    expect(rows[0].description).toBe("alpha consumes beta's API");
  });

  test("composite PK prevents duplicate relationships", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");

    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [alphaId, betaId, "depends_on"]
    );

    expect(() => {
      db.run(
        "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
        [alphaId, betaId, "depends_on"]
      );
    }).toThrow();
  });

  test("allows different relationship types between same repos", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");

    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [alphaId, betaId, "depends_on"]
    );
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [alphaId, betaId, "shares_types"]
    );

    const count = db.query(
      "SELECT COUNT(*) as n FROM repo_relationships WHERE source_repo_id = ? AND target_repo_id = ?"
    ).get(alphaId, betaId) as { n: number };
    expect(count.n).toBe(2);
  });

  test("queries return both directions", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");
    const gammaId = getRepoId("repo-gamma");

    // alpha -> beta
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [alphaId, betaId, "depends_on", "alpha uses beta"]
    );
    // gamma -> alpha
    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship, description) VALUES (?, ?, ?, ?)",
      [gammaId, alphaId, "deploys_with", "co-deployed"]
    );

    const rows = db.query(
      `SELECT rr.relationship, s.name as source_name, t.name as target_name
       FROM repo_relationships rr
       JOIN repos s ON s.id = rr.source_repo_id
       JOIN repos t ON t.id = rr.target_repo_id
       WHERE rr.source_repo_id = ? OR rr.target_repo_id = ?`
    ).all(alphaId, alphaId) as Array<{
      source_name: string;
      target_name: string;
      relationship: string;
    }>;

    expect(rows.length).toBe(2);
    const rels = rows.map((r) => `${r.source_name}->${r.target_name}`).sort();
    expect(rels).toEqual(["repo-alpha->repo-beta", "repo-gamma->repo-alpha"]);
  });

  test("delete removes the relationship", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");

    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [alphaId, betaId, "depends_on"]
    );

    const result = db.run(
      "DELETE FROM repo_relationships WHERE source_repo_id = ? AND target_repo_id = ? AND relationship = ?",
      [alphaId, betaId, "depends_on"]
    );
    expect(result.changes).toBe(1);

    const count = db.query("SELECT COUNT(*) as n FROM repo_relationships").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("cascade delete removes relationships when repo is deleted", () => {
    const db = getDb();
    const alphaId = getRepoId("repo-alpha");
    const betaId = getRepoId("repo-beta");

    db.run(
      "INSERT INTO repo_relationships (source_repo_id, target_repo_id, relationship) VALUES (?, ?, ?)",
      [alphaId, betaId, "depends_on"]
    );

    db.run("DELETE FROM repos WHERE id = ?", [alphaId]);

    const count = db.query("SELECT COUNT(*) as n FROM repo_relationships").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("repo_relationships: route handler logic", () => {
  // Import and test the Hono app directly without starting a server
  let app: import("hono").Hono;

  beforeAll(async () => {
    const { relationships } = await import("../src/daemon/routes/relationships");
    const { Hono } = await import("hono");
    app = new Hono();
    app.route("/repos", relationships);
  });

  beforeEach(() => {
    seedRepos();
  });

  async function req(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  test("POST /repos/:name/relationships creates a relationship", async () => {
    const res = await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
      description: "alpha calls beta API",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.source_repo).toBe("repo-alpha");
    expect(data.target_repo).toBe("repo-beta");
  });

  test("POST returns 409 on duplicate", async () => {
    await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    const res = await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    expect(res.status).toBe(409);
  });

  test("POST returns 400 for self-relationship", async () => {
    const res = await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-alpha",
      relationship: "depends_on",
    });
    expect(res.status).toBe(400);
  });

  test("POST returns 404 for unknown repos", async () => {
    const res = await req("POST", "/repos/nonexistent/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    expect(res.status).toBe(404);

    const res2 = await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "nonexistent",
      relationship: "depends_on",
    });
    expect(res2.status).toBe(404);
  });

  test("POST returns 400 for missing fields", async () => {
    const res = await req("POST", "/repos/repo-alpha/relationships", {});
    expect(res.status).toBe(400);
  });

  test("GET /repos/:name/relationships returns both directions", async () => {
    await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    await req("POST", "/repos/repo-gamma/relationships", {
      target_repo: "repo-alpha",
      relationship: "deploys_with",
    });

    const res = await req("GET", "/repos/repo-alpha/relationships");
    expect(res.status).toBe(200);
    const data = await res.json() as Array<{ source_name: string; target_name: string }>;
    expect(data.length).toBe(2);
  });

  test("GET /repos/:name/relationships returns 404 for unknown repo", async () => {
    const res = await req("GET", "/repos/nonexistent/relationships");
    expect(res.status).toBe(404);
  });

  test("GET /repos/relationships returns all", async () => {
    await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    await req("POST", "/repos/repo-gamma/relationships", {
      target_repo: "repo-beta",
      relationship: "shares_db",
    });

    const res = await req("GET", "/repos/relationships");
    expect(res.status).toBe(200);
    const data = await res.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(2);
  });

  test("DELETE removes a relationship", async () => {
    await req("POST", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });

    const res = await req("DELETE", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "depends_on",
    });
    expect(res.status).toBe(200);

    const list = await req("GET", "/repos/repo-alpha/relationships");
    const data = await list.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(0);
  });

  test("DELETE returns 404 for nonexistent relationship", async () => {
    const res = await req("DELETE", "/repos/repo-alpha/relationships", {
      target_repo: "repo-beta",
      relationship: "nonexistent",
    });
    expect(res.status).toBe(404);
  });
});
