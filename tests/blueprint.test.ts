import { describe, test, expect } from "bun:test";
import {
  createInitialState,
  advanceState,
  getNextNode,
} from "../src/orchestrator/blueprint";
import type { BlueprintState } from "../src/shared/types";

// Import the timeline builder from the pure logic module (not the React component)
import { buildTimelineNodes } from "../src/orchestrator/timeline";

// Helper: advance through the full plan-scrutinize pipeline
function advanceThroughPlanPipeline(state: BlueprintState): BlueprintState {
  state = advanceState(state, "done"); // plan -> scrutinize
  state = advanceState(state, "done"); // scrutinize -> plan_again
  state = advanceState(state, "done"); // plan_again -> scrutinize_final
  state = advanceState(state, "done"); // scrutinize_final -> finalize_plan
  state = advanceState(state, "done"); // finalize_plan -> implement
  return state;
}

// Helper: advance from index through to review
function advanceToReview(): BlueprintState {
  let state = createInitialState();
  state = advanceState(state, "done"); // -> plan
  state = advanceThroughPlanPipeline(state); // -> implement
  state = advanceState(state, "done"); // -> lint
  state = advanceState(state, "clean"); // -> ci
  state = advanceState(state, "pass"); // -> review
  return state;
}

// ---------------------------------------------------------------------------
// Blueprint state machine: normal flow
// ---------------------------------------------------------------------------

describe("blueprint state machine: normal flow", () => {
  test("initial state starts at index", () => {
    const state = createInitialState();
    expect(state.current_node).toBe("index");
    expect(state.history).toEqual([]);
  });

  test("plan -> scrutinize -> plan_again -> scrutinize_final -> finalize_plan -> implement", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    expect(state.current_node).toBe("plan");

    state = advanceState(state, "done"); // -> scrutinize
    expect(state.current_node).toBe("scrutinize");

    state = advanceState(state, "done"); // -> plan_again
    expect(state.current_node).toBe("plan_again");

    state = advanceState(state, "done"); // -> scrutinize_final
    expect(state.current_node).toBe("scrutinize_final");

    state = advanceState(state, "done"); // -> finalize_plan
    expect(state.current_node).toBe("finalize_plan");

    state = advanceState(state, "done"); // -> implement
    expect(state.current_node).toBe("implement");
  });

  test("advances through full happy path to commit", () => {
    let state = advanceToReview();
    expect(state.current_node).toBe("review");

    state = advanceState(state, "accept");
    expect(state.current_node).toBe("commit");
  });

  test("history entries are closed when advancing", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> scrutinize

    // First entry (plan) should be closed
    expect(state.history[0].node).toBe("plan");
    expect(state.history[0].exited_at).not.toBeNull();
    expect(state.history[0].result).toBe("done");

    // Second entry (scrutinize) should be open
    expect(state.history[1].node).toBe("scrutinize");
    expect(state.history[1].exited_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blueprint state machine: lint/ci fix loops
// ---------------------------------------------------------------------------

describe("blueprint state machine: fix loops", () => {
  test("lint errors triggers fix_lint loop", () => {
    let state = advanceToReview();
    // Rewind: test from implement -> lint -> fix_lint
    let s = createInitialState();
    s = advanceState(s, "done"); // -> plan
    s = advanceThroughPlanPipeline(s); // -> implement
    s = advanceState(s, "done"); // -> lint

    s = advanceState(s, "errors"); // -> fix_lint
    expect(s.current_node).toBe("fix_lint");

    s = advanceState(s, "done"); // -> lint
    expect(s.current_node).toBe("lint");

    s = advanceState(s, "clean"); // -> ci
    expect(s.current_node).toBe("ci");
  });

  test("ci fail triggers fix_ci loop", () => {
    let s = createInitialState();
    s = advanceState(s, "done"); // -> plan
    s = advanceThroughPlanPipeline(s); // -> implement
    s = advanceState(s, "done"); // -> lint
    s = advanceState(s, "clean"); // -> ci

    s = advanceState(s, "fail"); // -> fix_ci
    expect(s.current_node).toBe("fix_ci");

    s = advanceState(s, "done"); // -> ci
    expect(s.current_node).toBe("ci");

    s = advanceState(s, "pass"); // -> review
    expect(s.current_node).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Blueprint state machine: reject/revise cycles
// ---------------------------------------------------------------------------

describe("blueprint state machine: reject/revise", () => {
  test("revise transitions from review back to plan", () => {
    let state = advanceToReview();
    expect(state.current_node).toBe("review");

    state = advanceState(state, "revise");
    expect(state.current_node).toBe("plan");
  });

  test("revise creates new history entries for the second cycle", () => {
    let state = advanceToReview();
    const historyLengthAtReview = state.history.length;

    state = advanceState(state, "revise");
    expect(state.history.length).toBe(historyLengthAtReview + 1);

    const newEntry = state.history[state.history.length - 1];
    expect(newEntry.node).toBe("plan");
    expect(newEntry.exited_at).toBeNull();
  });

  test("full revise cycle goes through plan pipeline -> implement -> lint -> ci -> review again", () => {
    let state = advanceToReview();

    // Revise
    state = advanceState(state, "revise"); // -> plan
    state = advanceThroughPlanPipeline(state); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review
    expect(state.current_node).toBe("review");

    // History should have two plan entries, two implement entries, etc.
    const planEntries = state.history.filter((h) => h.node === "plan");
    expect(planEntries.length).toBe(2);

    const implementEntries = state.history.filter((h) => h.node === "implement");
    expect(implementEntries.length).toBe(2);

    const reviewEntries = state.history.filter((h) => h.node === "review");
    expect(reviewEntries.length).toBe(2);
  });

  test("multiple revise cycles are tracked", () => {
    let state = advanceToReview();

    // First revise
    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    // Second revise
    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    const planEntries = state.history.filter((h) => h.node === "plan");
    expect(planEntries.length).toBe(3);

    const implementEntries = state.history.filter((h) => h.node === "implement");
    expect(implementEntries.length).toBe(3);

    // Accept
    state = advanceState(state, "accept");
    expect(state.current_node).toBe("commit");
  });
});

// ---------------------------------------------------------------------------
// Blueprint: scrutinize error handling
// ---------------------------------------------------------------------------

describe("blueprint state machine: scrutinize errors", () => {
  test("scrutinize error goes to review", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> scrutinize
    state = advanceState(state, "error"); // -> review
    expect(state.current_node).toBe("review");
  });

  test("plan_again error goes to review", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> scrutinize
    state = advanceState(state, "done"); // -> plan_again
    state = advanceState(state, "error"); // -> review
    expect(state.current_node).toBe("review");
  });

  test("finalize_plan error goes to review", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceThroughPlanPipeline(state); // all the way to implement
    // But let's test finalize specifically
    let s = createInitialState();
    s = advanceState(s, "done"); // -> plan
    s = advanceState(s, "done"); // -> scrutinize
    s = advanceState(s, "done"); // -> plan_again
    s = advanceState(s, "done"); // -> scrutinize_final
    s = advanceState(s, "done"); // -> finalize_plan
    s = advanceState(s, "error"); // -> review
    expect(s.current_node).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Timeline builder
// ---------------------------------------------------------------------------

describe("buildTimelineNodes: normal flow", () => {
  test("shows index as first node at start", () => {
    const state = createInitialState();
    const nodes = buildTimelineNodes(state);
    expect(nodes[0]).toBe("index");
    expect(nodes).toContain("plan");
    expect(nodes).toContain("implement");
    expect(nodes).toContain("review");
    expect(nodes).toContain("commit");
  });

  test("shows scrutinize nodes in history", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> scrutinize

    const nodes = buildTimelineNodes(state);
    expect(nodes).toContain("plan");
    expect(nodes).toContain("scrutinize");
  });
});

describe("buildTimelineNodes: reject/revise cycles", () => {
  test("after revise, shows new plan in timeline", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise"); // -> plan

    const nodes = buildTimelineNodes(state);
    const planCount = nodes.filter((n) => n === "plan").length;
    expect(planCount).toBe(2);
  });

  test("after revise cycle completes, timeline shows full second cycle", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    const nodes = buildTimelineNodes(state);

    const planCount = nodes.filter((n) => n === "plan").length;
    expect(planCount).toBe(2);

    const implementCount = nodes.filter((n) => n === "implement").length;
    expect(implementCount).toBe(2);

    const reviewCount = nodes.filter((n) => n === "review").length;
    expect(reviewCount).toBe(2);

    expect(nodes[nodes.length - 1]).toBe("commit");
  });

  test("multiple revise cycles all appear in timeline", () => {
    let state = advanceToReview();

    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done");
    state = advanceState(state, "clean");
    state = advanceState(state, "pass");

    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done");
    state = advanceState(state, "clean");
    state = advanceState(state, "pass");

    const nodes = buildTimelineNodes(state);

    const planCount = nodes.filter((n) => n === "plan").length;
    expect(planCount).toBe(3);

    const implementCount = nodes.filter((n) => n === "implement").length;
    expect(implementCount).toBe(3);
  });

  test("revise mid-cycle shows correct upcoming nodes", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise");
    state = advanceThroughPlanPipeline(state);
    state = advanceState(state, "done"); // -> lint

    const nodes = buildTimelineNodes(state);
    expect(nodes).toContain("ci");
    expect(nodes).toContain("review");
    expect(nodes).toContain("commit");
  });
});
