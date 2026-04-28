process.env.HOTO_WORKSPACE = `/tmp/hoto-test-secret-discovery-${Date.now()}`;

import { describe, expect, test, beforeAll } from "bun:test";
import { discoverSecrets } from "../src/workspace/secret-discovery";
import { getDb } from "../src/knowledge/db";

beforeAll(() => {
  getDb();
  const db = getDb();
  db.run("INSERT INTO repos (id, name, path) VALUES (1, 'test-repo-1', 'git@example.com:test/repo1.git')");
  db.run("INSERT INTO repos (id, name, path) VALUES (2, 'test-repo-2', 'git@example.com:test/repo2.git')");
  db.run("INSERT INTO repos (id, name, path) VALUES (3, 'test-repo-3', 'https://example.com/repo3.git')");
  db.run("INSERT INTO repos (id, name, path) VALUES (4, 'test-repo-4', 'https://example.com/repo4.git')");
  db.run("INSERT INTO repos (id, name, path) VALUES (5, 'test-repo-5', 'https://example.com/repo5.git')");
});

describe("discoverSecrets — SSH and HTTPS auth patterns", () => {
  test("detects SSH Permission denied (publickey)", () => {
    const results = discoverSecrets(1, "git@github.com: Permission denied (publickey).");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const s = results.find((r) => r.key === "SSH_KEY");
    expect(s).toBeDefined();
    expect(s!.secret_type).toBe("ssh_key");
    expect(s!.description).toContain("--ssh-key");
  });

  test("detects SSH Host key verification failed", () => {
    const results = discoverSecrets(2, "Host key verification failed.\nfatal: Could not read from remote repository.");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const s = results.find((r) => r.key === "SSH_KNOWN_HOSTS");
    expect(s).toBeDefined();
    expect(s!.secret_type).toBe("ssh_key");
    expect(s!.description).toContain("known_hosts");
  });

  test("detects HTTPS invalid credentials", () => {
    const results = discoverSecrets(3, "remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/repo.git'");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const s = results.find((r) => r.key === "GIT_TOKEN");
    expect(s).toBeDefined();
    expect(s!.secret_type).toBe("env_var");
    expect(s!.description).toContain("$ENV_VAR");
  });

  test("detects HTTPS 403 via fatal: ...403", () => {
    const results = discoverSecrets(4, "fatal: repository 'https://example.com/repo.git/' not found 403");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const s = results.find((r) => r.key === "GIT_TOKEN");
    expect(s).toBeDefined();
    expect(s!.secret_type).toBe("env_var");
    expect(s!.description).toContain("403 Forbidden");
  });

  test("detects HTTPS 403 via 'The requested URL returned error: 403'", () => {
    const results = discoverSecrets(5, "error: The requested URL returned error: 403");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const s = results.find((r) => r.key === "GIT_TOKEN");
    expect(s).toBeDefined();
    expect(s!.secret_type).toBe("env_var");
    expect(s!.description).toContain("403 Forbidden");
  });
});
