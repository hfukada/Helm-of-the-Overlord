import type { BlueprintState } from "../api";

const NODE_LABELS: Record<string, string> = {
  index: "Index",
  plan: "Plan",
  implement: "Implement",
  lint: "Lint",
  fix_lint: "Fix Lint",
  ci: "CI",
  fix_ci: "Fix CI",
  review: "Review",
  commit: "Commit",
};

/**
 * Nodes that represent the "main" pipeline for the purposes of showing
 * upcoming (not-yet-reached) nodes after the current one.
 */
const UPCOMING_PIPELINE: string[] = [
  "index",
  "plan",
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
 * This means reject/revise cycles show additional implement->lint->ci nodes,
 * and fix_lint/fix_ci loops appear when they actually happen.
 */
function buildTimelineNodes(state: BlueprintState): string[] {
  const seen = new Set<string>();
  const nodes: string[] = [];

  // Add all nodes from history in order (dedup consecutive same-node entries
  // but allow the same node to appear again in a new cycle)
  let lastNode = "";
  for (const entry of state.history) {
    // Always add if it's a new node or a new cycle (previous node was different)
    if (entry.node !== lastNode) {
      nodes.push(entry.node);
      seen.add(entry.node);
    }
    lastNode = entry.node;
  }

  // Add current node if not the last in the list
  if (nodes[nodes.length - 1] !== state.current_node) {
    nodes.push(state.current_node);
    seen.add(state.current_node);
  }

  // Add upcoming main pipeline nodes that haven't been reached yet
  const currentIdx = UPCOMING_PIPELINE.indexOf(state.current_node);
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < UPCOMING_PIPELINE.length; i++) {
      const upcoming = UPCOMING_PIPELINE[i];
      // Only add if we haven't already shown this node in this cycle
      // Check if the last occurrence in nodes is completed
      if (!nodes.includes(upcoming) || isNodeCompleted(state, upcoming)) {
        if (nodes[nodes.length - 1] !== upcoming) {
          nodes.push(upcoming);
        }
      }
    }
  } else {
    // Current node isn't in main pipeline (e.g., fix_lint, fix_ci)
    // Show the remaining main nodes after the parent
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

function isNodeCompleted(state: BlueprintState, node: string): boolean {
  return state.history.some((h) => h.node === node && h.exited_at !== null);
}

export function BlueprintTimeline({
  state,
}: {
  state: BlueprintState | null;
}) {
  if (!state) return null;

  const timelineNodes = buildTimelineNodes(state);

  // Build a set of the most recent completed entries
  // For revise cycles, a node can appear multiple times. We consider the
  // last occurrence in history for status.
  const nodeStatus = new Map<
    number,
    { completed: boolean; failed: boolean; current: boolean }
  >();

  for (let i = 0; i < timelineNodes.length; i++) {
    const node = timelineNodes[i];
    const isCurrent = node === state.current_node && i === timelineNodes.lastIndexOf(node);

    // Find the matching history entry for this position
    // Walk history entries for this node name, mapping to timeline positions
    const historyEntries = state.history.filter((h) => h.node === node);
    // Count how many times this node appears before position i in timeline
    let occurrenceIdx = 0;
    for (let j = 0; j < i; j++) {
      if (timelineNodes[j] === node) occurrenceIdx++;
    }
    const entry = historyEntries[occurrenceIdx];

    const completed = entry?.exited_at !== null && entry !== undefined;
    const failed =
      entry?.result === "failure" ||
      entry?.result === "error" ||
      entry?.result === "errors";

    nodeStatus.set(i, {
      completed: completed && !isCurrent,
      failed,
      current: isCurrent,
    });
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {timelineNodes.map((node, i) => {
        const status = nodeStatus.get(i) ?? {
          completed: false,
          failed: false,
          current: false,
        };

        let bg = "bg-gray-800 text-gray-500 border border-gray-700";
        if (status.current) bg = "bg-indigo-600 text-white border border-indigo-500";
        else if (status.failed) bg = "bg-red-900 text-red-200 border border-red-700";
        else if (status.completed) bg = "bg-emerald-900 text-emerald-200 border border-emerald-700";

        return (
          <div key={`${node}-${i}`} className="flex items-center">
            {i > 0 && (
              <div
                className={`h-0.5 w-4 ${
                  status.completed || status.current
                    ? "bg-green-600"
                    : "bg-gray-700"
                }`}
              />
            )}
            <div
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap ${bg} ${
                status.current ? "animate-pulse" : ""
              }`}
            >
              {status.completed && !status.failed && (
                <span className="text-green-300">&#10003;</span>
              )}
              {status.failed && <span className="text-red-300">&#10005;</span>}
              {NODE_LABELS[node] ?? node}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { buildTimelineNodes };
