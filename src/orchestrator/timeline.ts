import type { BlueprintState } from "../shared/types";

/**
 * Nodes that represent the "main" pipeline for the purposes of showing
 * upcoming (not-yet-reached) nodes after the current one.
 */
const UPCOMING_PIPELINE: string[] = [
  "index",
  "plan",
  "scrutinize",
  "plan_again",
  "scrutinize_final",
  "finalize_plan",
  "implement",
  "lint",
  "ci",
  "review",
  "commit",
];

/**
 * Build the timeline dynamically from blueprint history + current node.
 *
 * Instead of a static list, we show:
 * 1. All nodes that have been entered (from history), in order
 * 2. The current node (if not already in history)
 * 3. Upcoming nodes from the main pipeline (dimmed/pending)
 *
 * This means reject/revise cycles show additional plan->implement nodes,
 * and fix_lint/fix_ci loops appear when they actually happen.
 */
export function buildTimelineNodes(state: BlueprintState): string[] {
  const nodes: string[] = [];

  // Add all nodes from history in order (dedup consecutive same-node entries
  // but allow the same node to appear again in a new cycle)
  let lastNode = "";
  for (const entry of state.history) {
    if (entry.node !== lastNode) {
      nodes.push(entry.node);
    }
    lastNode = entry.node;
  }

  // Add current node if not the last in the list
  if (nodes[nodes.length - 1] !== state.current_node) {
    nodes.push(state.current_node);
  }

  // Add upcoming main pipeline nodes that haven't been reached yet
  const currentIdx = UPCOMING_PIPELINE.indexOf(state.current_node);
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < UPCOMING_PIPELINE.length; i++) {
      const upcoming = UPCOMING_PIPELINE[i];
      if (nodes[nodes.length - 1] !== upcoming) {
        nodes.push(upcoming);
      }
    }
  } else {
    // Current node isn't in main pipeline (e.g., fix_lint, fix_ci)
    const parentMap: Record<string, string> = {
      fix_lint: "lint",
      fix_ci: "ci",
    };
    const parent = parentMap[state.current_node];
    if (parent) {
      const parentIdx = UPCOMING_PIPELINE.indexOf(parent);
      for (let i = parentIdx + 1; i < UPCOMING_PIPELINE.length; i++) {
        const upcoming = UPCOMING_PIPELINE[i];
        if (nodes[nodes.length - 1] !== upcoming) {
          nodes.push(upcoming);
        }
      }
    }
  }

  return nodes;
}
