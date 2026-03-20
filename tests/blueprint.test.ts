import { describe, test, expect } from "bun:test";
import {
  createInitialState,
  advanceState,
  getNextNode,
} from "../src/orchestrator/blueprint";
import type { BlueprintState } from "../src/shared/types";

// Import the timeline builder from the pure logic module (not the React component)
import { buildTimelineNodes } from "../src/web/src/components/blueprint-timeline-logic";

// ---------------------------------------------------------------------------
// Blueprint state machine: normal flow
// ---------------------------------------------------------------------------

describe("blueprint state machine: normal flow", () => {
  test("initial state starts at index", () => {
    const state = createInitialState();
    expect(state.current_node).toBe("index");
    expect(state.history).toEqual([]);
  });

  test("advances through full happy path", () => {
    let state = createInitialState();

    // index -> plan
    state = advanceState(state, "done");
    expect(state.current_node).toBe("plan");
    expect(state.history.length).toBe(1);
    expect(state.history[0].node).toBe("plan");
    expect(state.history[0].exited_at).toBeNull();

    // plan -> implement
    state = advanceState(state, "done");
    expect(state.current_node).toBe("implement");

    // implement -> lint
    state = advanceState(state, "done");
    expect(state.current_node).toBe("lint");

    // lint -> ci (clean)
    state = advanceState(state, "clean");
    expect(state.current_node).toBe("ci");

    // ci -> review (pass)
    state = advanceState(state, "pass");
    expect(state.current_node).toBe("review");

    // review -> commit (accept)
    state = advanceState(state, "accept");
    expect(state.current_node).toBe("commit");
  });

  test("history entries are closed when advancing", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement

    // First entry (plan) should be closed
    expect(state.history[0].node).toBe("plan");
    expect(state.history[0].exited_at).not.toBeNull();
    expect(state.history[0].result).toBe("done");

    // Second entry (implement) should be open
    expect(state.history[1].node).toBe("implement");
    expect(state.history[1].exited_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blueprint state machine: lint/ci fix loops
// ---------------------------------------------------------------------------

describe("blueprint state machine: fix loops", () => {
  test("lint errors triggers fix_lint loop", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint

    // Lint has errors
    state = advanceState(state, "errors");
    expect(state.current_node).toBe("fix_lint");

    // Fix done -> back to lint
    state = advanceState(state, "done");
    expect(state.current_node).toBe("lint");

    // Lint clean -> ci
    state = advanceState(state, "clean");
    expect(state.current_node).toBe("ci");
  });

  test("ci fail triggers fix_ci loop", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci

    // CI fails
    state = advanceState(state, "fail");
    expect(state.current_node).toBe("fix_ci");

    // Fix done -> back to ci
    state = advanceState(state, "done");
    expect(state.current_node).toBe("ci");

    // CI passes
    state = advanceState(state, "pass");
    expect(state.current_node).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Blueprint state machine: reject/revise cycles
// ---------------------------------------------------------------------------

describe("blueprint state machine: reject/revise", () => {
  function advanceToReview(): BlueprintState {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review
    return state;
  }

  test("revise transitions from review back to implement", () => {
    let state = advanceToReview();
    expect(state.current_node).toBe("review");

    state = advanceState(state, "revise");
    expect(state.current_node).toBe("implement");
  });

  test("revise creates new history entries for the second cycle", () => {
    let state = advanceToReview();
    const historyLengthAtReview = state.history.length;

    state = advanceState(state, "revise");
    expect(state.history.length).toBe(historyLengthAtReview + 1);

    // The new implement entry
    const newEntry = state.history[state.history.length - 1];
    expect(newEntry.node).toBe("implement");
    expect(newEntry.exited_at).toBeNull();
  });

  test("full revise cycle goes through implement -> lint -> ci -> review again", () => {
    let state = advanceToReview();

    // Revise
    state = advanceState(state, "revise"); // -> implement
    expect(state.current_node).toBe("implement");

    state = advanceState(state, "done"); // -> lint
    expect(state.current_node).toBe("lint");

    state = advanceState(state, "clean"); // -> ci
    expect(state.current_node).toBe("ci");

    state = advanceState(state, "pass"); // -> review
    expect(state.current_node).toBe("review");

    // History should have two implement entries, two lint entries, etc.
    const implementEntries = state.history.filter((h) => h.node === "implement");
    expect(implementEntries.length).toBe(2);

    const reviewEntries = state.history.filter((h) => h.node === "review");
    expect(reviewEntries.length).toBe(2);
  });

  test("multiple revise cycles are tracked", () => {
    let state = advanceToReview();

    // First revise
    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    // Second revise
    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    const implementEntries = state.history.filter((h) => h.node === "implement");
    expect(implementEntries.length).toBe(3); // original + 2 revisions

    // Accept
    state = advanceState(state, "accept");
    expect(state.current_node).toBe("commit");
  });
});

// ---------------------------------------------------------------------------
// Timeline builder: dynamic node list
// ---------------------------------------------------------------------------

describe("buildTimelineNodes: normal flow", () => {
  test("shows index as first node at start", () => {
    const state = createInitialState();
    const nodes = buildTimelineNodes(state);
    expect(nodes[0]).toBe("index");
    // Should also show upcoming pipeline nodes
    expect(nodes).toContain("plan");
    expect(nodes).toContain("implement");
    expect(nodes).toContain("review");
    expect(nodes).toContain("commit");
  });

  test("shows completed nodes plus upcoming", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement

    const nodes = buildTimelineNodes(state);
    // Should show: index(from initial), plan(history), implement(current), lint, ci, review, commit
    expect(nodes).toContain("plan");
    expect(nodes).toContain("implement");
    expect(nodes).toContain("lint");
    expect(nodes).toContain("review");
    expect(nodes).toContain("commit");
  });

  test("includes fix_lint when it appears in history", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "errors"); // -> fix_lint

    const nodes = buildTimelineNodes(state);
    expect(nodes).toContain("fix_lint");
  });

  test("includes fix_ci when it appears in history", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "fail"); // -> fix_ci

    const nodes = buildTimelineNodes(state);
    expect(nodes).toContain("fix_ci");
  });
});

describe("buildTimelineNodes: reject/revise cycles", () => {
  function advanceToReview(): BlueprintState {
    let state = createInitialState();
    state = advanceState(state, "done"); // -> plan
    state = advanceState(state, "done"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review
    return state;
  }

  test("after revise, shows new implement in timeline", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise"); // -> implement

    const nodes = buildTimelineNodes(state);

    // Should have implement appearing twice
    const implementCount = nodes.filter((n) => n === "implement").length;
    expect(implementCount).toBe(2);
  });

  test("after revise cycle completes, timeline shows full second cycle", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    const nodes = buildTimelineNodes(state);

    // Should have two cycles visible
    const implementCount = nodes.filter((n) => n === "implement").length;
    expect(implementCount).toBe(2);

    const reviewCount = nodes.filter((n) => n === "review").length;
    expect(reviewCount).toBe(2);

    // commit should still appear at the end
    expect(nodes[nodes.length - 1]).toBe("commit");
  });

  test("multiple revise cycles all appear in timeline", () => {
    let state = advanceToReview();

    // Two revise cycles
    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint
    state = advanceState(state, "clean"); // -> ci
    state = advanceState(state, "pass"); // -> review

    const nodes = buildTimelineNodes(state);

    const implementCount = nodes.filter((n) => n === "implement").length;
    expect(implementCount).toBe(3);

    const reviewCount = nodes.filter((n) => n === "review").length;
    expect(reviewCount).toBe(3);
  });

  test("revise mid-cycle shows correct upcoming nodes", () => {
    let state = advanceToReview();
    state = advanceState(state, "revise"); // -> implement
    state = advanceState(state, "done"); // -> lint

    const nodes = buildTimelineNodes(state);

    // Current is lint, should show ci, review, commit upcoming
    expect(nodes).toContain("ci");
    expect(nodes).toContain("review");
    expect(nodes).toContain("commit");
  });
});
