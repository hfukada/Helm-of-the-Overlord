import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteTask, fetchTasks, type TaskSummary } from "../api";
import { StatusBadge } from "./StatusBadge";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(`${dateStr}Z`).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TaskList() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const params = useParams();
  const activeId = params.id;
  const navigate = useNavigate();

  useEffect(() => {
    const load = () => fetchTasks().then(setTasks).catch(() => {});
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleDeleteConfirm(id: string) {
    setDeletingId(null);
    await deleteTask(id).catch(() => {});
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (activeId === id) {
      navigate("/");
    }
  }

  return (
    <div className="py-2">
      {tasks.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-gray-500">
          No tasks yet
        </div>
      )}
      {tasks.map((task) => (
        <div key={task.id} className="relative">
          <Link
            to={`/tasks/${task.id}`}
            className={`block border-b border-gray-700/50 px-4 py-3 hover:bg-gray-800/50 ${
              task.id === activeId ? "bg-gray-800" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{task.title}</div>
                <div className="mt-1 text-xs text-gray-400">
                  {timeAgo(task.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={task.status} />
                {deletingId === task.id ? (
                  <span
                    className="flex items-center gap-1"
                    onClick={(e) => e.preventDefault()}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteConfirm(task.id);
                      }}
                      className="rounded bg-red-600 px-1.5 py-0.5 text-xs text-white hover:bg-red-500"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDeletingId(null);
                      }}
                      className="rounded bg-gray-600 px-1.5 py-0.5 text-xs text-white hover:bg-gray-500"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeletingId(task.id);
                    }}
                    className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-red-900/40 hover:text-red-400"
                  >
                    delete
                  </button>
                )}
              </div>
            </div>
          </Link>
        </div>
      ))}
    </div>
  );
}
