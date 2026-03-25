import { describe, test, expect } from "bun:test";
import { parseMultiRepoPlan } from "../src/orchestrator/plan-parser";

describe("parseMultiRepoPlan", () => {
  test("single repo: returns entire plan", () => {
    const plan = "### Summary\nDo stuff\n\n### Files to Modify\n- foo.ts\n\n### Steps\n1. thing";
    const result = parseMultiRepoPlan(plan, ["my-api"]);
    expect(result.size).toBe(1);
    expect(result.get("my-api")).toBe(plan);
  });

  test("multi-repo: splits by ## [repo-name] headers", () => {
    const plan = `### Summary
Cross-repo auth changes.

## [my-api]

### Files to Modify
- src/auth.ts

### Steps
1. Add auth middleware

## [my-frontend]

### Files to Modify
- src/login.ts

### Steps
1. Add login page`;

    const result = parseMultiRepoPlan(plan, ["my-api", "my-frontend"]);
    expect(result.size).toBe(2);

    const apiPlan = result.get("my-api")!;
    expect(apiPlan).toContain("Cross-repo auth changes");
    expect(apiPlan).toContain("Add auth middleware");
    expect(apiPlan).not.toContain("Add login page");

    const fePlan = result.get("my-frontend")!;
    expect(fePlan).toContain("Cross-repo auth changes");
    expect(fePlan).toContain("Add login page");
    expect(fePlan).not.toContain("Add auth middleware");
  });

  test("multi-repo with no headers: gives whole plan to each repo", () => {
    const plan = "### Summary\nDo stuff\n### Steps\n1. thing";
    const result = parseMultiRepoPlan(plan, ["my-api", "my-frontend"]);
    expect(result.size).toBe(2);
    expect(result.get("my-api")).toBe(plan);
    expect(result.get("my-frontend")).toBe(plan);
  });

  test("ignores headers for repos not in the list", () => {
    const plan = `### Summary
Changes.

## [my-api]
API stuff

## [unknown-repo]
This should be ignored

## [my-frontend]
Frontend stuff`;

    const result = parseMultiRepoPlan(plan, ["my-api", "my-frontend"]);
    expect(result.size).toBe(2);
    // my-api section should include unknown-repo content since it's between the headers
    const apiPlan = result.get("my-api")!;
    expect(apiPlan).toContain("API stuff");
  });

  test("summary is prepended to each repo section", () => {
    const plan = `### Summary
The overall approach.

### Affected Repos
- my-api: needs work

## [my-api]

### Steps
1. Do thing`;

    const result = parseMultiRepoPlan(plan, ["my-api"]);
    const apiPlan = result.get("my-api")!;
    expect(apiPlan).toContain("The overall approach");
    expect(apiPlan).toContain("Do thing");
  });
});
