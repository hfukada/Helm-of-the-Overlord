import { describe, it, expect, afterEach } from "bun:test";
import { expandEnvVars } from "../src/shared/expand-env";

describe("expandEnvVars", () => {
  const set: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of Object.keys(set)) {
      if (set[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = set[key];
      }
    }
    for (const key of Object.keys(set)) {
      delete set[key];
    }
  });

  function setEnv(key: string, value: string | undefined) {
    set[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it("passes through a plain URL with no tokens", () => {
    expect(expandEnvVars("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("replaces a $VAR token", () => {
    setEnv("TEST_TOKEN", "secret");
    expect(expandEnvVars("https://$TEST_TOKEN@github.com/org/repo.git")).toBe(
      "https://secret@github.com/org/repo.git"
    );
  });

  it("replaces a ${VAR} token", () => {
    setEnv("TEST_TOKEN", "secret");
    expect(expandEnvVars("https://${TEST_TOKEN}@github.com/org/repo.git")).toBe(
      "https://secret@github.com/org/repo.git"
    );
  });

  it("replaces multiple tokens in one string", () => {
    setEnv("MY_USER", "alice");
    setEnv("MY_PASS", "hunter2");
    expect(expandEnvVars("https://$MY_USER:${MY_PASS}@github.com/org/repo.git")).toBe(
      "https://alice:hunter2@github.com/org/repo.git"
    );
  });

  it("throws with a clear message when a variable is missing", () => {
    setEnv("DEFINITELY_MISSING_VAR", undefined);
    expect(() => expandEnvVars("https://$DEFINITELY_MISSING_VAR@host/repo")).toThrow(
      "Missing environment variable: DEFINITELY_MISSING_VAR"
    );
  });

  it("substitutes an empty string when the variable is set to empty string", () => {
    setEnv("EMPTY_VAR", "");
    expect(expandEnvVars("https://${EMPTY_VAR}host/repo")).toBe("https://host/repo");
  });
});
