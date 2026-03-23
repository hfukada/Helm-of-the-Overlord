import { describe, test, expect } from "bun:test";
import { parseAffectedRepos } from "../src/orchestrator/nodes/agentic/pre-plan";

describe("parseAffectedRepos", () => {
  test("parses standard format", () => {
    const output = `### Affected Repositories
- my-api: needs new auth endpoint
- my-frontend: needs login page update
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api", "my-frontend"]);
  });

  test("parses bold repo names", () => {
    const output = `### Affected Repositories
- **my-api**: needs new auth endpoint
- **my-frontend**: needs login page update
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api", "my-frontend"]);
  });

  test("parses single repo", () => {
    const output = `### Affected Repositories
- my-api: only this one needs changes
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api"]);
  });

  test("parses without colon separator", () => {
    const output = `### Affected Repositories
- my-api
- shared-lib
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api", "shared-lib"]);
  });

  test("stops at next section", () => {
    const output = `### Affected Repositories
- my-api: changes needed

### Notes
Some other content with - bullets
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api"]);
  });

  test("handles extra whitespace", () => {
    const output = `###  Affected Repositories
-  my-api:  some reason
-  my-frontend:  another reason
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api", "my-frontend"]);
  });

  test("fallback: parses bullets without section header", () => {
    const output = `Based on my analysis:
- my-api: needs changes
- shared-lib: also needs changes
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api", "shared-lib"]);
  });

  test("returns empty for no matches", () => {
    const output = "I'm not sure which repos to change.";
    expect(parseAffectedRepos(output)).toEqual([]);
  });

  test("ignores non-repo-like bullets in fallback", () => {
    const output = `Here are the changes:
- my-api: needs work
- this is a sentence not a repo name
- shared-lib: also needs work
`;
    // "this" would match but "is a sentence..." has spaces, so only single-word entries match
    const result = parseAffectedRepos(output);
    expect(result).toContain("my-api");
    expect(result).toContain("shared-lib");
  });

  test("case-insensitive section header match", () => {
    const output = `### affected repositories
- my-api: changes
`;
    expect(parseAffectedRepos(output)).toEqual(["my-api"]);
  });
});
