import { describe, it, expect } from "bun:test";
import {
  restartFromPhase,
  createInitialState,
  advanceState,
} from "../src/orchestrator/blueprint";

describe("restartFromPhase", () => {
  it("resets current_node and zeroes round counts", () => {
    let state = createInitialState();
    state = advanceState(state, "done"); // index → plan
    const result = restartFromPhase(state, "index");
    expect(result.current_node).toBe("index");
    expect(result.ci_rounds).toBe(0);
    expect(result.lint_rounds).toBe(0);
  });

  it("trims history to entries before the first occurrence of the phase", () => {
    let state = createInitialState();
    // Manually add the index entry as runTask does, so history has a closed index entry
    state.history.push({ node: "index", entered_at: new Date().toISOString(), exited_at: null, result: null });
    state = advanceState(state, "done"); // index → plan (closes index entry, pushes plan)
    state = advanceState(state, "done"); // plan → scrutinize (closes plan, pushes scrutinize)
    const result = restartFromPhase(state, "plan");
    expect(result.current_node).toBe("plan");
    expect(result.history).toHaveLength(1);
    expect(result.history[0].node).toBe("index");
  });

  it("preserves all history when restarting a phase not in history", () => {
    const state = createInitialState(); // history is empty, current is index
    const result = restartFromPhase(state, "plan");
    expect(result.current_node).toBe("plan");
    expect(result.history).toHaveLength(0); // nothing to trim
  });

  it("throws for an unknown phase name", () => {
    const state = createInitialState();
    expect(() => restartFromPhase(state, "does_not_exist" as any)).toThrow(
      "Unknown phase: does_not_exist"
    );
  });
});
