import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "repo-parser-test-"));
}

function fakeProcess(jsonOutput: string, exitCode = 0) {
  return {
    stdout: new Blob([jsonOutput]).stream(),
    stderr: new Blob([""]).stream(),
    exited: Promise.resolve(exitCode),
  };
}

describe("parseRepo", () => {
  let originalSpawn: typeof Bun.spawn;
  let spawnCallCount: number;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnCallCount = 0;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  test("LLM inference used for a Go repo", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/foo\n\ngo 1.21\n");
    writeFileSync(join(dir, "CLAUDE.md"), "Run tests with go test -race ./...\n");

    (Bun as any).spawn = (_cmds: string[], _opts: unknown) => {
      spawnCallCount++;
      return fakeProcess('{"test_cmd":"go test -race ./...","lint_cmd":"staticcheck ./..."}');
    };

    const { parseRepo } = await import(`../src/knowledge/repo-parser?t=${Date.now()}`);
    const result = await parseRepo(dir);

    expect(spawnCallCount).toBe(1);
    expect(result.test_cmd).toBe("go test -race ./...");
    expect(result.lint_cmd).toBe("staticcheck ./...");
  });

  test("package.json scripts take priority over LLM output", async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
    );
    writeFileSync(join(dir, "README.md"), "Some docs\n");

    (Bun as any).spawn = (_cmds: string[], _opts: unknown) => {
      spawnCallCount++;
      return fakeProcess('{"test_cmd":"something-else","lint_cmd":"something-else"}');
    };

    const { parseRepo } = await import(`../src/knowledge/repo-parser?t=${Date.now()}`);
    const result = await parseRepo(dir);

    expect(result.test_cmd).toBe("npm run test");
    expect(result.lint_cmd).toBe("npm run lint");
  });

  test("no doc files means no LLM call, fields remain null", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/foo\n\ngo 1.21\n");

    (Bun as any).spawn = (_cmds: string[], _opts: unknown) => {
      spawnCallCount++;
      return fakeProcess("{}");
    };

    const { parseRepo } = await import(`../src/knowledge/repo-parser?t=${Date.now()}`);
    const result = await parseRepo(dir);

    expect(spawnCallCount).toBe(0);
    expect(result.test_cmd).toBe("go test ./...");
    expect(result.lint_cmd).toBe("golangci-lint run");
  });
});
