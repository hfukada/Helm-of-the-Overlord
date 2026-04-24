import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";

process.env.HOTO_WORKSPACE = "/tmp/hoto-test-secrets";

import { mock } from "bun:test";

mock.module("../src/knowledge/chromadb", () => ({
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
  mkdirSync("/tmp/hoto-test-secrets", { recursive: true });
  const db = getDb();

  db.run(
    `INSERT OR IGNORE INTO repos (name, url, local_path, created_at, updated_at)
     VALUES ('testrepo', 'http://example.com/testrepo.git', '/tmp/testrepo', datetime('now'), datetime('now'))`
  );

  const { secrets } = await import("../src/daemon/routes/secrets");
  app = new Hono();
  app.route("/repos", secrets);
});

describe("POST /repos/:repoName/secrets", () => {
  test("ssh_key with valid host_path returns 201", async () => {
    const res = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "ssh_key",
        key: "MY_SSH_KEY",
        value_source: "host_file",
        host_path: "/root/.ssh/id_rsa",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toBe("MY_SSH_KEY");
  });

  test("ssh_key without host_path returns 400", async () => {
    const res = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "ssh_key",
        key: "SSH_KEY_NO_PATH",
        value_source: "host_file",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("ssh_key with known_hosts_path returns 201 and field is persisted", async () => {
    const res = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "ssh_key",
        key: "MY_SSH_KEY_WITH_KNOWN_HOSTS",
        value_source: "host_file",
        host_path: "/root/.ssh/id_rsa",
        known_hosts_path: "/root/.ssh/known_hosts",
      }),
    });
    expect(res.status).toBe(201);

    const listRes = await app.request("/repos/testrepo/secrets");
    const secrets = await listRes.json() as Array<{ key: string; known_hosts_path: string | null }>;
    const entry = secrets.find((s) => s.key === "MY_SSH_KEY_WITH_KNOWN_HOSTS");
    expect(entry?.known_hosts_path).toBe("/root/.ssh/known_hosts");
  });

  test("env_var type still accepted (regression)", async () => {
    const res = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "env_var",
        key: "MY_ENV_VAR",
        value_source: "host_env",
      }),
    });
    expect(res.status).toBe(201);
  });

  test("auth_file type still accepted (regression)", async () => {
    const res = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "auth_file",
        key: "MY_AUTH_FILE",
        value_source: "host_file",
        host_path: "/root/.docker/config.json",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /repos/:repoName/secrets/:secretId", () => {
  test("update known_hosts_path returns 200", async () => {
    const createRes = await app.request("/repos/testrepo/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret_type: "ssh_key",
        key: "PATCHABLE_SSH_KEY",
        value_source: "host_file",
        host_path: "/root/.ssh/id_rsa",
      }),
    });
    const { id } = await createRes.json() as { id: number };

    const patchRes = await app.request(`/repos/testrepo/secrets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ known_hosts_path: "/root/.ssh/known_hosts" }),
    });
    expect(patchRes.status).toBe(200);

    const listRes = await app.request("/repos/testrepo/secrets");
    const secrets = await listRes.json() as Array<{ id: number; known_hosts_path: string | null }>;
    const entry = secrets.find((s) => s.id === id);
    expect(entry?.known_hosts_path).toBe("/root/.ssh/known_hosts");
  });
});
