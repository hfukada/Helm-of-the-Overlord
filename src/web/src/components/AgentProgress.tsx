import { useEffect, useRef, useState } from "react";
import { fetchAgentStream, type StreamEvent } from "../api";

export function AgentProgress({
  taskId,
  runId,
  isRunning,
}: {
  taskId: string;
  runId: string;
  isRunning: boolean;
}) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const lastIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning && events.length > 0) return;

    const poll = () => {
      fetchAgentStream(taskId, runId, lastIdRef.current)
        .then((newEvents) => {
          if (newEvents.length > 0) {
            lastIdRef.current = newEvents[newEvents.length - 1].id;
            setEvents((prev) => [...prev, ...newEvents]);
          }
        })
        .catch(() => {});
    };

    poll();
    if (!isRunning) return;

    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [taskId, runId, isRunning]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  if (events.length === 0) {
    return isRunning ? (
      <div className="py-2 text-xs text-gray-500">Waiting for output...</div>
    ) : null;
  }

  return (
    <div
      ref={containerRef}
      className="max-h-96 overflow-y-auto rounded bg-gray-900 p-3 text-xs font-mono"
    >
      {events.map((event) => (
        <EventBlock key={event.id} event={event} />
      ))}
    </div>
  );
}

function EventBlock({ event }: { event: StreamEvent }) {
  switch (event.event_type) {
    case "thinking":
      return (
        <div className="mb-1 italic text-gray-500">{event.content}</div>
      );
    case "text":
      return <div className="mb-1 text-gray-300">{event.content}</div>;
    case "tool_use":
      return (
        <div className="mb-1 ml-2 border-l-2 border-blue-700 pl-2 text-blue-300">
          <span className="font-bold">Tool: </span>
          {event.content}
        </div>
      );
    case "tool_result":
      return (
        <div className="mb-1 ml-2 border-l-2 border-gray-700 pl-2 text-gray-500 max-h-24 overflow-hidden">
          {event.content.slice(0, 500)}
          {event.content.length > 500 && "..."}
        </div>
      );
    case "error":
      return (
        <div className="mb-1 text-red-400">{event.content}</div>
      );
    default:
      return (
        <div className="mb-1 text-gray-400">{event.content}</div>
      );
  }
}
