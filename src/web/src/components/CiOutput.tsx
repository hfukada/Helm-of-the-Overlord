import { useEffect, useRef, useState } from "react";
import { fetchCiOutput } from "../api";

interface CiOutputProps {
  taskId: string;
  isRunning: boolean;
  initialOutput: string | null;
  initialPassed: number | null;
}

export function CiOutput({
  taskId,
  isRunning,
  initialOutput,
  initialPassed,
}: CiOutputProps) {
  const [output, setOutput] = useState<string | null>(initialOutput);
  const [passed, setPassed] = useState<number | null>(initialPassed);
  const [following, setFollowing] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Sync from parent props when not running (final state)
  useEffect(() => {
    if (!isRunning) {
      setOutput(initialOutput);
      setPassed(initialPassed);
    }
  }, [isRunning, initialOutput, initialPassed]);

  // Poll ci-output frequently when running
  useEffect(() => {
    if (!isRunning) return;

    const poll = () => {
      fetchCiOutput(taskId)
        .then((res) => {
          setOutput(res.ci_output);
          setPassed(res.ci_passed);
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 500);
    return () => clearInterval(interval);
  }, [taskId, isRunning]);

  // Auto-open the details panel when CI starts running
  useEffect(() => {
    if (isRunning && detailsRef.current) {
      detailsRef.current.open = true;
    }
  }, [isRunning]);

  // Auto-scroll to bottom when following is enabled and output changes
  useEffect(() => {
    if (following && output && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, following]);

  if (!output && !isRunning) return null;

  return (
    <details ref={detailsRef} className="rounded border border-gray-700 bg-gray-900/50">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium hover:bg-gray-800/50">
        <span
          className={`h-2 w-2 rounded-full ${
            isRunning
              ? "animate-pulse bg-blue-400"
              : passed
                ? "bg-green-400"
                : "bg-red-400"
          }`}
        />
        CI
        <span className="ml-auto text-xs text-gray-400">
          {isRunning ? "running..." : passed ? "passed" : "failed"}
        </span>
      </summary>
      <div className="border-t border-gray-700 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={following}
              onChange={(e) => setFollowing(e.target.checked)}
              className="accent-blue-500"
            />
            Follow newest output
          </label>
        </div>
        <div ref={containerRef} className="max-h-96 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words text-xs text-gray-300">
            {output ?? "Waiting for output..."}
          </pre>
        </div>
      </div>
    </details>
  );
}
