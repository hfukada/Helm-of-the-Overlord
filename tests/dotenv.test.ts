import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolate env state for each test
const TEST_KEYS = ["DOTENV_TEST_A", "DOTENV_TEST_B", "DOTENV_TEST_C", "DOTENV_TEST_QUOTED"];
beforeEach(() => {
  for (const k of TEST_KEYS) delete process.env[k];
});

// Import after env isolation is set up
const { loadDotenv } = await import("../src/shared/dotenv");

describe("loadDotenv", () => {
  it("sets new variables from a .env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoto-dotenv-"));
    const file = join(dir, ".env");
    await writeFile(file, "DOTENV_TEST_A=hello\nDOTENV_TEST_B=world\n");
    await loadDotenv(file);
    expect(process.env.DOTENV_TEST_A).toBe("hello");
    expect(process.env.DOTENV_TEST_B).toBe("world");
  });

  it("does not overwrite already-set variables", async () => {
    process.env.DOTENV_TEST_A = "original";
    const dir = await mkdtemp(join(tmpdir(), "hoto-dotenv-"));
    const file = join(dir, ".env");
    await writeFile(file, "DOTENV_TEST_A=overwritten\n");
    await loadDotenv(file);
    expect(process.env.DOTENV_TEST_A).toBe("original");
  });

  it("ignores blank lines and comment lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoto-dotenv-"));
    const file = join(dir, ".env");
    await writeFile(file, "\n# this is a comment\nDOTENV_TEST_C=set\n");
    await loadDotenv(file);
    expect(process.env.DOTENV_TEST_C).toBe("set");
  });

  it("strips surrounding quotes from values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoto-dotenv-"));
    const file = join(dir, ".env");
    await writeFile(file, 'DOTENV_TEST_QUOTED="quoted value"\n');
    await loadDotenv(file);
    expect(process.env.DOTENV_TEST_QUOTED).toBe("quoted value");
  });

  it("does not throw when the file does not exist", async () => {
    await expect(loadDotenv("/tmp/hoto-nonexistent-dotenv-xyz.env")).resolves.toBeUndefined();
  });

  it("does not throw when the file is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hoto-dotenv-"));
    const file = join(dir, ".env");
    await writeFile(file, "DOTENV_TEST_A=x\n");
    await chmod(file, 0o000);
    await expect(loadDotenv(file)).resolves.toBeUndefined();
    await chmod(file, 0o644); // restore so cleanup works
  });
});
