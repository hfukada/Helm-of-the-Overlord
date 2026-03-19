import { useState, useRef, useEffect } from "react";
import {
  postComment,
  updateComment,
  deleteComment,
  type DiffComment,
} from "../api";

export function CommentThread({
  taskId,
  comments,
  filePath,
  lineNumber,
  side,
  autoFocus,
  onCommentAdded,
  onCommentUpdated,
  onCommentDeleted,
  onCancel,
}: {
  taskId: string;
  comments: DiffComment[];
  filePath: string;
  lineNumber: number;
  side: string;
  autoFocus?: boolean;
  onCommentAdded: (comment: DiffComment) => void;
  onCommentUpdated: (comment: DiffComment) => void;
  onCommentDeleted: (id: number) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(autoFocus || comments.length === 0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = async () => {
    if (!body.trim()) return;
    setSubmitting(true);
    try {
      const comment = await postComment(taskId, filePath, lineNumber, side, body);
      onCommentAdded(comment);
      setBody("");
      setShowForm(false);
    } catch {
      // Silently fail
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (comment: DiffComment) => {
    try {
      const updated = await updateComment(comment.id, {
        resolved: !comment.resolved,
      });
      onCommentUpdated(updated);
    } catch {}
  };

  const handleDelete = async (comment: DiffComment) => {
    try {
      await deleteComment(comment.id);
      onCommentDeleted(comment.id);
    } catch {}
  };

  const resolvedComments = comments.filter((c) => c.resolved);
  const activeComments = comments.filter((c) => !c.resolved);

  return (
    <div className="bg-gray-900 border-l-2 border-indigo-600 p-3 text-sm">
      {/* Active comments */}
      {activeComments.map((comment) => (
        <div key={comment.id} className="mb-2 rounded bg-gray-800 p-2">
          <div className="text-gray-300">{comment.body}</div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <button
              onClick={() => handleResolve(comment)}
              className="text-gray-500 hover:text-green-400"
            >
              Resolve
            </button>
            <button
              onClick={() => handleDelete(comment)}
              className="text-gray-500 hover:text-red-400"
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {/* Resolved comments (collapsed) */}
      {resolvedComments.length > 0 && (
        <details className="mb-2">
          <summary className="cursor-pointer text-xs text-gray-500">
            {resolvedComments.length} resolved comment
            {resolvedComments.length !== 1 ? "s" : ""}
          </summary>
          {resolvedComments.map((comment) => (
            <div
              key={comment.id}
              className="mt-1 rounded bg-gray-800/50 p-2 text-gray-500"
            >
              <div className="line-through">{comment.body}</div>
              <button
                onClick={() => handleResolve(comment)}
                className="mt-1 text-xs hover:text-white"
              >
                Unresolve
              </button>
            </div>
          ))}
        </details>
      )}

      {/* New comment form */}
      {showForm ? (
        <div>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write a comment..."
            className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleSubmit();
              }
              if (e.key === "Escape") {
                onCancel?.();
                setShowForm(false);
              }
            }}
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting || !body.trim()}
              className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? "Posting..." : "Comment"}
            </button>
            <button
              onClick={() => {
                onCancel?.();
                setShowForm(false);
              }}
              className="text-xs text-gray-500 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="text-xs text-gray-500 hover:text-indigo-400"
        >
          + Add comment
        </button>
      )}
    </div>
  );
}
