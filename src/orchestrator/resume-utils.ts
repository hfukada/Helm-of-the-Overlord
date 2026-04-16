import type { BlueprintState } from "../shared/types";

export interface ResumePoint {
  node: BlueprintState["current_node"];
  cleanHistory: BlueprintState["history"];
}

/**
 * Scans blueprint_state history for the last interrupted phase
 * (entry where exited_at === null). If found, strips it and returns
 * its node as the resume point. If all entries have exited_at set,
 * returns current_node with history unchanged (resume from next phase).
 */
export function findResumePoint(state: BlueprintState): ResumePoint {
  const history = state.history ?? [];
  const interruptedIndex = [...history].reverse().findIndex((e) => e.exited_at === null);

  if (interruptedIndex !== -1) {
    const realIndex = history.length - 1 - interruptedIndex;
    const node = history[realIndex].node;
    const cleanHistory = history.filter((_, i) => i !== realIndex);
    return { node, cleanHistory };
  }

  return { node: state.current_node, cleanHistory: history };
}
