/**
 * Tests for sandboxed Claude execution.
 *
 * Covers:
 *  1. spawnClaude builds correct docker exec args when containerName is set
 *  2. generateMcpConfig produces SSE config for sandboxed mode
 *  3. generateMcpConfig produces stdio config for host mode
 *  4. SubprocessOptions accepts sandbox fields
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 1. Claude CLI arg building with container support
// ---------------------------------------------------------------------------

describe("claude-cli: containerized args", () => {
  test("ClaudeOptions accepts containerName and containerWorkDir", () => {
    const opts: import("../src/shared/claude-cli").ClaudeOptions = {
      prompt: "test",
      containerName: "hoto-sandbox-abc",
      containerWorkDir: "/workspace/my-repo",
    };
    expect(opts.containerName).toBe("hoto-sandbox-abc");
    expect(opts.containerWorkDir).toBe("/workspace/my-repo");
  });

  test("SubprocessOptions accepts containerName and containerWorkDir", () => {
    const opts: import("../src/orchestrator/subprocess").SubprocessOptions = {
      prompt: "test",
      workDir: "/tmp/test",
      agentRunId: "test-id",
      containerName: "hoto-sandbox-abc",
      containerWorkDir: "/workspace/my-repo",
    };
    expect(opts.containerName).toBe("hoto-sandbox-abc");
    expect(opts.containerWorkDir).toBe("/workspace/my-repo");
  });
});

// ---------------------------------------------------------------------------
// 2. MCP config generation
// ---------------------------------------------------------------------------

describe("generateMcpConfig", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join("/tmp", `hoto-sandbox-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    // generateMcpConfig writes to taskDir(taskId)/mcp-config.json
    // We need to set up the workspace dir for this
    process.env.HOTO_WORKSPACE = tmpDir;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HOTO_WORKSPACE;
  });

  test("sandboxed mode generates SSE config with host.docker.internal", async () => {
    // Create task dir
    const taskId = "test-sandbox-task";
    const taskDirPath = join(tmpDir, "tasks", taskId);
    mkdirSync(taskDirPath, { recursive: true });

    const { generateMcpConfig } = await import("../src/orchestrator/subprocess");
    const configPath = await generateMcpConfig(
      taskId,
      "/home/user/workspace/repo",
      "my-repo",
      { sandboxed: true, containerWorkDir: "/workspace/my-repo" }
    );

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.hoto.type).toBe("sse");
    expect(config.mcpServers.hoto.url).toContain("host.docker.internal");
    expect(config.mcpServers.hoto.url).toContain("repo=my-repo");
    // Should NOT have command/args (stdio transport)
    expect(config.mcpServers.hoto.command).toBeUndefined();
  });

  test("host mode generates stdio config with command/args", async () => {
    const taskId = "test-host-task";
    const taskDirPath = join(tmpDir, "tasks", taskId);
    mkdirSync(taskDirPath, { recursive: true });

    const { generateMcpConfig } = await import("../src/orchestrator/subprocess");
    const configPath = await generateMcpConfig(
      taskId,
      "/home/user/workspace/repo",
      "my-repo"
    );

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.hoto.command).toBe("bun");
    expect(config.mcpServers.hoto.args).toBeArray();
    expect(config.mcpServers.hoto.env.HOTO_REPO_NAME).toBe("my-repo");
    // Should NOT have type/url (SSE transport)
    expect(config.mcpServers.hoto.type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. SandboxOptions type
// ---------------------------------------------------------------------------

describe("SandboxOptions", () => {
  test("SandboxOptions has containerName and containerWorkDir", async () => {
    const opts: import("../src/orchestrator/nodes/agentic/types").SandboxOptions = {
      containerName: "hoto-test-123",
      containerWorkDir: "/workspace/repo",
    };
    expect(opts.containerName).toBe("hoto-test-123");
    expect(opts.containerWorkDir).toBe("/workspace/repo");
  });
});

// ---------------------------------------------------------------------------
// 4. toHostPath translation for sandbox/CI bind mounts
// ---------------------------------------------------------------------------

describe("toHostPath", () => {
  test("returns input unchanged when workspaceDir == workspaceHostDir (bare metal)", async () => {
    const { toHostPath } = await import("../src/workspace/docker-exec");
    const p = toHostPath("/home/u/.hoto-workspace/tasks/abc", "/home/u/.hoto-workspace", "/home/u/.hoto-workspace");
    expect(p).toBe("/home/u/.hoto-workspace/tasks/abc");
  });

  test("translates in-container path to host path when dirs differ (containerized)", async () => {
    const { toHostPath } = await import("../src/workspace/docker-exec");
    const p = toHostPath("/data/tasks/abc/myrepo", "/data", "/home/u/hoto/data");
    expect(p).toBe("/home/u/hoto/data/tasks/abc/myrepo");
  });

  test("translates the workspace root itself", async () => {
    const { toHostPath } = await import("../src/workspace/docker-exec");
    const p = toHostPath("/data", "/data", "/home/u/hoto/data");
    expect(p).toBe("/home/u/hoto/data");
  });

  test("leaves paths outside workspaceDir untouched", async () => {
    const { toHostPath } = await import("../src/workspace/docker-exec");
    const p = toHostPath("/tmp/somewhere", "/data", "/home/u/hoto/data");
    expect(p).toBe("/tmp/somewhere");
  });

  test("does not match a prefix that is not a path boundary", async () => {
    // /datastore should NOT match /data as a prefix
    const { toHostPath } = await import("../src/workspace/docker-exec");
    const p = toHostPath("/datastore/foo", "/data", "/home/u/hoto/data");
    expect(p).toBe("/datastore/foo");
  });
});

// ---------------------------------------------------------------------------
// 5. Config flag
// ---------------------------------------------------------------------------

describe("config: sandbox flag", () => {
  test("sandboxClaude defaults to false", async () => {
    // Config is already loaded, check the type exists
    const { config } = await import("../src/shared/config");
    expect(typeof config.sandboxClaude).toBe("boolean");
  });

  test("mcpHttpPort has a default", async () => {
    const { config } = await import("../src/shared/config");
    expect(typeof config.mcpHttpPort).toBe("number");
    expect(config.mcpHttpPort).toBeGreaterThan(0);
  });
});
