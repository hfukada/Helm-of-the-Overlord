import { Routes, Route, Link, useLocation } from "react-router-dom";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { TokenSummary } from "./components/TokenSummary";
import { TaskSubmitForm } from "./components/TaskSubmitForm";
import { useState } from "react";

export function App() {
  const [showNewTask, setShowNewTask] = useState(false);
  const _location = useLocation();

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900 px-4 py-3">
        <Link to="/" className="text-lg font-bold text-white">
          Hoto
        </Link>
        <div className="flex items-center gap-4">
          <Link
            to="/tokens"
            className="text-sm text-gray-400 hover:text-white"
          >
            Tokens
          </Link>
          <button
            onClick={() => setShowNewTask(true)}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            New Task
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-gray-800 bg-gray-900/50">
          <TaskList />
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Routes>
            <Route
              path="/"
              element={
                <div className="flex h-full items-center justify-center text-gray-500">
                  Select a task or create a new one
                </div>
              }
            />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route
              path="/tokens"
              element={<TokenSummaryPage />}
            />
          </Routes>
        </main>
      </div>

      {/* New Task Modal */}
      {showNewTask && (
        <TaskSubmitForm onClose={() => setShowNewTask(false)} />
      )}
    </div>
  );
}

function TokenSummaryPage() {
  return (
    <div>
      <h2 className="mb-4 text-xl font-bold">Token Usage</h2>
      <TokenSummary />
    </div>
  );
}
