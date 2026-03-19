import type { BlueprintState } from "../api";

const PIPELINE_NODES = [
  "plan",
  "implement",
  "lint",
  "ci",
  "review",
  "commit",
];

const NODE_LABELS: Record<string, string> = {
  plan: "Plan",
  implement: "Implement",
  lint: "Lint",
  push: "Push",
  ci: "CI",
  fix_lint: "Fix Lint",
  fix_ci: "Fix CI",
  review: "Review",
  revise: "Revise",
  commit: "Commit",
};

export function BlueprintTimeline({
  state,
}: {
  state: BlueprintState | null;
}) {
  if (!state) return null;

  const completedNodes = new Set(
    state.history
      .filter((h) => h.exited_at !== null)
      .map((h) => h.node)
  );
  const failedNodes = new Set(
    state.history
      .filter((h) => h.result === "failure" || h.result === "error")
      .map((h) => h.node)
  );
  const currentNode = state.current_node;

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {PIPELINE_NODES.map((node, i) => {
        const isCurrent = node === currentNode;
        const isCompleted = completedNodes.has(node) && !isCurrent;
        const isFailed = failedNodes.has(node);

        let bg = "bg-gray-700 text-gray-400";
        if (isCurrent) bg = "bg-indigo-600 text-white";
        else if (isFailed) bg = "bg-red-700 text-red-200";
        else if (isCompleted) bg = "bg-green-700 text-green-200";

        return (
          <div key={node} className="flex items-center">
            {i > 0 && (
              <div
                className={`h-0.5 w-4 ${
                  isCompleted || isCurrent ? "bg-green-600" : "bg-gray-700"
                }`}
              />
            )}
            <div
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${bg} ${
                isCurrent ? "animate-pulse" : ""
              }`}
            >
              {isCompleted && !isFailed && (
                <span className="text-green-300">&#10003;</span>
              )}
              {isFailed && <span className="text-red-300">&#10005;</span>}
              {NODE_LABELS[node] ?? node}
            </div>
          </div>
        );
      })}
    </div>
  );
}
