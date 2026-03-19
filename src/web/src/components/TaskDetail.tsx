import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  fetchTask,
  cancelTask,
  type TaskDetail as TaskDetailType,
} from "../api";
import { StatusBadge } from "./StatusBadge";
import { BlueprintTimeline } from "./BlueprintTimeline";
import { TaskTokenSummary } from "./TokenSummary";
import { AgentProgress } from "./AgentProgress";
import { DiffView } from "./DiffView";
import { CommitDialog } from "./CommitDialog";

const TERMINAL_STATUSES = new Set([
  "committed",
  "failed",
  "cancelled",
]);

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!id) return;

    setTask(null);
    setError(null);
    setExpandedRuns(new Set());

    const load = () =>
      fetchTask(id)
        .then(setTask)
        .catch((err) =>
          setError(err instanceof Error ? err.message : "Failed to load")
        );

    load();
    const interval = setInterval(() => {
      // Stop polling for terminal statuses
      if (task && TERMINAL_STATUSES.has(task.status)) return;
      load();
    }, 2000);

    return () => clearInterval(interval);
  }, [id, task]);

  if (error) {
    return (
      <div className="rounded bg-red-900/30 p-4 text-red-300">{error}</div>
    );
  }

  if (!task) {
    return <div className="text-gray-500">Loading...</div>;
  }

  const toggleRun = (runId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const handleCancel = async () => {
    if (!confirm("Cancel this task? The worktree and branch will be removed.")) return;
    setCancelling(true);
    try {
      await cancelTask(task.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{task.title}</h1>
            <p className="mt-1 text-sm text-gray-400">{task.description}</p>
          </div>
          <StatusBadge status={task.status} />
        </div>
        <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
          {task.branch_name && <span>Branch: {task.branch_name}</span>}
          <span>Created: {new Date(`${task.created_at}Z`).toLocaleString()}</span>
          <TaskTokenSummary runs={task.agent_runs} />
        </div>
      </div>

      {/* Blueprint Timeline */}
      <BlueprintTimeline state={task.blueprint_state} />

      {/* Agent Runs */}
      {task.agent_runs.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-gray-300">
            Agent Runs
          </h2>
          <div className="space-y-2">
            {task.agent_runs.map((run) => (
              <div
                key={run.id}
                className="rounded border border-gray-800 bg-gray-900/50"
              >
                <button
                  onClick={() => toggleRun(run.id)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-gray-800/50"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        run.status === "running"
                          ? "animate-pulse bg-blue-400"
                          : run.status === "completed"
                            ? "bg-green-400"
                            : "bg-red-400"
                      }`}
                    />
                    <span className="font-medium capitalize">
                      {run.node_name.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-gray-500">{run.model}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {run.cost_usd > 0 && (
                      <span>${run.cost_usd.toFixed(4)}</span>
                    )}
                    <span>{expandedRuns.has(run.id) ? "v" : ">"}</span>
                  </div>
                </button>
                {expandedRuns.has(run.id) && (
                  <div className="border-t border-gray-800 px-4 py-3">
                    <AgentProgress
                      taskId={task.id}
                      runId={run.id}
                      isRunning={run.status === "running"}
                    />
                    {run.error && (
                      <div className="mt-2 rounded bg-red-900/30 p-2 text-xs text-red-300">
                        {run.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Diff (when in review) */}
      {task.diff && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-gray-300">
            Changes
            {task.diff_summary && (
              <span className="ml-2 font-normal text-gray-500">
                {task.diff_summary.length} file
                {task.diff_summary.length !== 1 ? "s" : ""}
              </span>
            )}
          </h2>
          <DiffView taskId={task.id} diff={task.diff} />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {(task.status === "review" || task.status === "accepted") && task.diff && (
          <button
            onClick={() => setShowCommit(true)}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
          >
            Accept & Commit
          </button>
        )}
        {task.status === "review" && !task.diff && (
          <span className="text-sm text-yellow-400">
            No changes detected in worktree
          </span>
        )}
        {!TERMINAL_STATUSES.has(task.status) && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="rounded bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelling ? "Cancelling..." : "Cancel Task"}
          </button>
        )}
      </div>

      {/* Commit Dialog */}
      {showCommit && (
        <CommitDialog
          task={task}
          onClose={() => setShowCommit(false)}
          onCommitted={() => {
            setShowCommit(false);
            // Refresh will happen via polling
          }}
        />
      )}
    </div>
  );
}
