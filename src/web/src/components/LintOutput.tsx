import { useEffect, useRef, useState } from "react";
import { fetchLintOutput } from "../api";

interface LintOutputProps {
  taskId: string;
  isRunning: boolean;
  initialOutput: string | null;
  initialPassed: number | null;
}

export function LintOutput({
  taskId,
  isRunning,
  initialOutput,
  initialPassed,
}: LintOutputProps) {
  const [output, setOutput] = useState<string | null>(initialOutput);
  const [passed, setPassed] = useState<number | null>(initialPassed);
  const containerRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Sync from parent props when not running (final state)
  useEffect(() => {
    if (!isRunning) {
      setOutput(initialOutput);
      setPassed(initialPassed);
    }
  }, [isRunning, initialOutput, initialPassed]);

  // Poll lint-output when running
  useEffect(() => {
    if (!isRunning) return;

    const poll = () => {
      fetchLintOutput(taskId)
        .then((res) => {
          setOutput(res.lint_output);
          setPassed(res.lint_passed);
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [taskId, isRunning]);

  // Auto-open when lint starts
  useEffect(() => {
    if (isRunning && detailsRef.current) {
      detailsRef.current.open = true;
    }
  }, [isRunning]);

  // Auto-scroll
  useEffect(() => {
    if (isRunning && output && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, isRunning]);

  if (!output && !isRunning) return null;

  return (
    <details
      ref={detailsRef}
      open={isRunning || (output !== null && !passed)}
      className="rounded border border-gray-700 bg-gray-900/50"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium hover:bg-gray-800/50">
        <span
          className={`h-2 w-2 rounded-full ${
            isRunning
              ? "animate-pulse bg-blue-400"
              : passed
                ? "bg-green-400"
                : "bg-yellow-400"
          }`}
        />
        Lint
        <span className="ml-auto text-xs text-gray-400">
          {isRunning ? "running..." : passed ? "passed" : "failed"}
        </span>
      </summary>
      <div className="border-t border-gray-700 px-4 py-3">
        <div ref={containerRef} className="max-h-96 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words text-xs text-gray-300">
            {output ?? "Waiting for output..."}
          </pre>
        </div>
      </div>
    </details>
  );
}
