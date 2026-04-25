import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { isSshUrl } from "../src/daemon/routes/repos";
import { Hono } from "hono";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-repos";

mock.module("../src/knowledge/chromadb", () => ({
  isChromaAvailable: async () => false,
  upsertDocuments: async () => {},
  queryDocuments: async () => [],
  deleteCollectionItems: async () => {},
  deleteCollection: async () => {},
}));

mock.module("../src/knowledge/repo-parser", () => ({
  parseRepo: async () => ({
    description: null,
    language: null,
    framework: null,
    build_cmd: null,
    test_cmd: null,
    run_cmd: null,
    lint_cmd: null,
    docker_compose_path: null,
    docker_image: null,
  }),
}));

mock.module("../src/knowledge/indexer", () => ({
  indexRepo: async () => ({ chunks: 0, embeddings: 0 }),
}));

mock.module("../src/gitea/client", () => ({
  embedGiteaCredentials: (u: string) => u,
  mirrorRepoToGitea: async () => {},
  isGiteaConfigured: () => false,
}));

mock.module("../src/messaging/manager", () => ({
  getMessagingManager: () => null,
}));

mock.module("../src/shared/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { getDb } from "../src/knowledge/db";

let app: Hono;

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hoto-test-repos", { recursive: true });
  getDb();

  const { repos } = await import("../src/daemon/routes/repos");
  app = new Hono();
  app.route("/repos", repos);
});

function clearRepos() {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM repos");
  db.exec("PRAGMA foreign_keys = ON");
}

function insertRepo(name: string, extra_context: string | null = null) {
  const db = getDb();
  db.run(
    `INSERT INTO repos (name, path, description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, docker_compose_path, docker_image, ci_on_host, extra_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, `/tmp/repos/${name}`, null, null, null, null, null, null, null, null, null, 0, extra_context]
  );
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("isSshUrl", () => {
  test("returns true for git@ URLs", () => {
    expect(isSshUrl("git@github.com:org/repo.git")).toBe(true);
  });
  test("returns false for https URLs", () => {
    expect(isSshUrl("https://github.com/org/repo.git")).toBe(false);
  });
});

describe("repos API", () => {
  beforeEach(() => {
    clearRepos();
  });

  test("PATCH /:name sets extra_context", async () => {
    insertRepo("myrepo", null);
    const res = await req("PATCH", "/repos/myrepo", { extra_context: "update API too" });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.extra_context).toBe("update API too");
  });

  test("PATCH /:name clears extra_context", async () => {
    insertRepo("myrepo", "old text");
    const res = await req("PATCH", "/repos/myrepo", { extra_context: null });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.extra_context).toBeNull();
  });

  test("PATCH /:name preserves extra_context when not in body", async () => {
    insertRepo("myrepo", "keep me");
    const res = await req("PATCH", "/repos/myrepo", { description: "new desc" });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.extra_context).toBe("keep me");
  });

  test("GET / includes extra_context field", async () => {
    insertRepo("myrepo", "some notes");
    const res = await req("GET", "/repos");
    expect(res.status).toBe(200);
    const data = await res.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(1);
    expect(data[0].extra_context).toBe("some notes");
  });
});
