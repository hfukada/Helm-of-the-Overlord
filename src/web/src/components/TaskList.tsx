import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTasks, type TaskSummary } from "../api";
import { StatusBadge } from "./StatusBadge";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
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
  const params = useParams();
  const activeId = params.id;

  useEffect(() => {
    const load = () => fetchTasks().then(setTasks).catch(() => {});
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="py-2">
      {tasks.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-gray-500">
          No tasks yet
        </div>
      )}
      {tasks.map((task) => (
        <Link
          key={task.id}
          to={`/tasks/${task.id}`}
          className={`block border-b border-gray-800 px-4 py-3 hover:bg-gray-800/50 ${
            task.id === activeId ? "bg-gray-800" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{task.title}</div>
              <div className="mt-1 text-xs text-gray-500">
                {timeAgo(task.created_at)}
              </div>
            </div>
            <StatusBadge status={task.status} />
          </div>
        </Link>
      ))}
    </div>
  );
}
