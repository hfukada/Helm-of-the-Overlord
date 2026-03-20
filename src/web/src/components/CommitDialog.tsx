import { useState } from "react";
import { acceptTask, commitTask, type TaskDetail } from "../api";

export function CommitDialog({
  task,
  onClose,
  onCommitted,
}: {
  task: TaskDetail;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [message, setMessage] = useState(task.title);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleCommit = async () => {
    if (!message.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      // Accept first if still in review
      if (task.status === "review") {
        await acceptTask(task.id);
      }

      await commitTask(task.id, message);
      setSuccess(true);
      setTimeout(onCommitted, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold">Commit & Push</h2>

        {success ? (
          <div className="rounded bg-green-900/50 p-4 text-green-300">
            Committed and pushed to {task.branch_name}
          </div>
        ) : (
          <>
            <div className="mb-4">
              <label className="mb-1 block text-sm text-gray-400">
                Commit Message
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500"
                rows={3}
              />
            </div>

            {task.branch_name && (
              <div className="mb-4 text-xs text-gray-400">
                Branch: {task.branch_name}
              </div>
            )}

            {task.diff_summary && (
              <div className="mb-4 text-xs text-gray-400">
                {task.diff_summary.length} file
                {task.diff_summary.length !== 1 ? "s" : ""} changed
                {" / "}
                <span className="text-green-400">
                  +
                  {task.diff_summary.reduce(
                    (s, f) => s + f.insertions,
                    0
                  )}
                </span>
                {" "}
                <span className="text-red-400">
                  -
                  {task.diff_summary.reduce(
                    (s, f) => s + f.deletions,
                    0
                  )}
                </span>
              </div>
            )}

            {error && (
              <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded px-4 py-2 text-sm text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleCommit}
                disabled={submitting || !message.trim()}
                className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
              >
                {submitting ? "Committing..." : "Commit & Push"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
