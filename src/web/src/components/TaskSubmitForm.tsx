import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRepos, submitTask, type Repo } from "../api";

export function TaskSubmitForm({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchRepos().then(setRepos).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await submitTask(
        description,
        selectedRepo || undefined,
        "web"
      );
      onClose();
      navigate(`/tasks/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-lg bg-gray-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold">New Task</h2>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="mb-1 block text-sm text-gray-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              rows={4}
              placeholder="Describe what you want to build or fix..."
              autoFocus
            />
          </div>

          {repos.length > 1 && (
            <div className="mb-4">
              <label className="mb-1 block text-sm text-gray-400">
                Repository
              </label>
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Auto-detect</option>
                {repos.map((repo) => (
                  <option key={repo.name} value={repo.name}>
                    {repo.name}
                    {repo.language ? ` (${repo.language})` : ""}
                  </option>
                ))}
              </select>
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
              type="submit"
              disabled={submitting || !description.trim()}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
