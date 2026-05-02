import { describe, test, expect } from "bun:test";
import { parseRevisorResponse } from "../src/projects/revisor";

describe("parseRevisorResponse", () => {
  test("parses bare JSON", () => {
    const text = JSON.stringify({
      rationale: "all good",
      changes: "none",
      milestones: [],
    });
    const r = parseRevisorResponse(text);
    expect(r).not.toBeNull();
    expect(r!.changes).toBe("none");
    expect(r!.rationale).toBe("all good");
    expect(r!.milestones).toEqual([]);
  });

  test("parses fenced JSON block", () => {
    const text = "Some preamble.\n```json\n" + JSON.stringify({
      rationale: "rewriting",
      changes: "revised",
      milestones: [
        { title: "New M1", description: "do thing", files_estimate: 3 },
      ],
    }) + "\n```\nTrailing chatter.";
    const r = parseRevisorResponse(text);
    expect(r).not.toBeNull();
    expect(r!.changes).toBe("revised");
    expect(r!.milestones).toHaveLength(1);
    expect(r!.milestones[0].title).toBe("New M1");
  });

  test("returns null for unparseable text", () => {
    expect(parseRevisorResponse("just a sentence")).toBeNull();
  });

  test("returns null when changes is invalid", () => {
    const text = JSON.stringify({ rationale: "x", changes: "maybe", milestones: [] });
    expect(parseRevisorResponse(text)).toBeNull();
  });

  test("returns null when milestones is missing fields", () => {
    const text = JSON.stringify({
      rationale: "x",
      changes: "revised",
      milestones: [{ title: "ok" }],
    });
    expect(parseRevisorResponse(text)).toBeNull();
  });

  test("returns null when milestones is not an array", () => {
    const text = JSON.stringify({
      rationale: "x",
      changes: "none",
      milestones: "not an array",
    });
    expect(parseRevisorResponse(text)).toBeNull();
  });
});
