import { useState, useEffect, useMemo, useCallback } from "react";
import { parseDiff, Diff, Hunk, markEdits, tokenize } from "react-diff-view";
import "react-diff-view/style/index.css";
import { fetchComments, type DiffComment } from "../api";
import { CommentThread } from "./CommentThread";

export function DiffView({
  taskId,
  diff,
}: {
  taskId: string;
  diff: string;
}) {
  const [viewType, setViewType] = useState<"unified" | "split">("unified");
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [commentAnchor, setCommentAnchor] = useState<{
    filePath: string;
    lineNumber: number;
    side: string;
  } | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<number>>(
    new Set()
  );

  useEffect(() => {
    fetchComments(taskId).then(setComments).catch(() => {});
  }, [taskId]);

  const files = useMemo(() => {
    try {
      return parseDiff(diff, { nearbySequences: "zip" });
    } catch {
      return [];
    }
  }, [diff]);

  const handleCommentAdded = useCallback((comment: DiffComment) => {
    setComments((prev) => [...prev, comment]);
    setCommentAnchor(null);
  }, []);

  const handleCommentUpdated = useCallback((updated: DiffComment) => {
    setComments((prev) =>
      prev.map((c) => (c.id === updated.id ? updated : c))
    );
  }, []);

  const handleCommentDeleted = useCallback((id: number) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const toggleFile = (idx: number) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="rounded bg-gray-800 p-4">
        <pre className="text-xs text-gray-400 whitespace-pre-wrap">
          {diff}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => setViewType("unified")}
          className={`rounded px-2 py-1 text-xs ${
            viewType === "unified"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          Unified
        </button>
        <button
          onClick={() => setViewType("split")}
          className={`rounded px-2 py-1 text-xs ${
            viewType === "split"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          Split
        </button>
      </div>

      <div className="space-y-4">
        {files.map((file, idx) => {
          const filePath =
            file.newPath === "/dev/null" ? file.oldPath : file.newPath;
          const isCollapsed = collapsedFiles.has(idx);

          return (
            <FileSection
              key={idx}
              idx={idx}
              file={file}
              filePath={filePath}
              viewType={viewType}
              isCollapsed={isCollapsed}
              taskId={taskId}
              comments={comments.filter((c) => c.file_path === filePath)}
              commentAnchor={
                commentAnchor?.filePath === filePath ? commentAnchor : null
              }
              onToggle={() => toggleFile(idx)}
              onGutterClick={(lineNumber, side) =>
                setCommentAnchor({ filePath, lineNumber, side })
              }
              onCommentAdded={handleCommentAdded}
              onCommentUpdated={handleCommentUpdated}
              onCommentDeleted={handleCommentDeleted}
              onCancelAnchor={() => setCommentAnchor(null)}
            />
          );
        })}
      </div>
    </div>
  );
}

function FileSection({
  file,
  filePath,
  viewType,
  isCollapsed,
  taskId,
  comments,
  commentAnchor,
  onToggle,
  onGutterClick,
  onCommentAdded,
  onCommentUpdated,
  onCommentDeleted,
  onCancelAnchor,
}: {
  idx: number;
  file: ReturnType<typeof parseDiff>[number];
  filePath: string;
  viewType: "unified" | "split";
  isCollapsed: boolean;
  taskId: string;
  comments: DiffComment[];
  commentAnchor: { lineNumber: number; side: string } | null;
  onToggle: () => void;
  onGutterClick: (lineNumber: number, side: string) => void;
  onCommentAdded: (comment: DiffComment) => void;
  onCommentUpdated: (comment: DiffComment) => void;
  onCommentDeleted: (id: number) => void;
  onCancelAnchor: () => void;
}) {
  // Build widgets map for inline comments
  const widgets = useMemo(() => {
    const w: Record<string, React.ReactElement> = {};
    const grouped = new Map<string, DiffComment[]>();

    for (const comment of comments) {
      if (comment.line_number != null) {
        const key = `${comment.side === "left" ? "old" : "new"}-${comment.line_number}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)?.push(comment);
      }
    }

    for (const [key, lineComments] of grouped) {
      w[key] = (
        <CommentThread
          taskId={taskId}
          comments={lineComments}
          filePath={filePath}
          lineNumber={lineComments[0].line_number!}
          side={lineComments[0].side}
          onCommentAdded={onCommentAdded}
          onCommentUpdated={onCommentUpdated}
          onCommentDeleted={onCommentDeleted}
        />
      );
    }

    // New comment anchor
    if (commentAnchor) {
      const key = `${commentAnchor.side === "left" ? "old" : "new"}-${commentAnchor.lineNumber}`;
      if (!w[key]) {
        w[key] = (
          <CommentThread
            taskId={taskId}
            comments={[]}
            filePath={filePath}
            lineNumber={commentAnchor.lineNumber}
            side={commentAnchor.side}
            autoFocus
            onCommentAdded={onCommentAdded}
            onCommentUpdated={onCommentUpdated}
            onCommentDeleted={onCommentDeleted}
            onCancel={onCancelAnchor}
          />
        );
      }
    }

    return w;
  }, [
    comments,
    commentAnchor,
    taskId,
    filePath,
    onCommentAdded,
    onCommentUpdated,
    onCommentDeleted,
    onCancelAnchor,
  ]);

  const tokens = useMemo(() => {
    try {
      return tokenize(file.hunks, {
        highlight: false,
        enhancers: [markEdits(file.hunks)],
      });
    } catch {
      return undefined;
    }
  }, [file.hunks]);

  const handleTableClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      // Only trigger on gutter cell clicks
      const cell = target.closest("td.diff-gutter");
      if (!cell) return;

      const lineNum = cell.getAttribute("data-line-number");
      if (!lineNum) return;

      const isOldSide = cell.classList.contains("diff-gutter-old");
      onGutterClick(parseInt(lineNum, 10), isOldSide ? "left" : "right");
    },
    [onGutterClick]
  );

  return (
    <div className="overflow-hidden rounded border border-gray-800">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-gray-800/50 px-4 py-2 text-left text-sm font-mono hover:bg-gray-800"
      >
        <span className="text-gray-500">{isCollapsed ? ">" : "v"}</span>
        <span className="text-gray-300">{filePath}</span>
      </button>
      {!isCollapsed && (
        <div
          className="diff-view-wrapper overflow-x-auto"
          onClick={handleTableClick}
        >
          <Diff
            viewType={viewType}
            diffType={file.type}
            hunks={file.hunks}
            tokens={tokens}
            widgets={widgets}
          >
            {(hunks) =>
              hunks.map((hunk) => (
                <Hunk key={hunk.content} hunk={hunk} />
              ))
            }
          </Diff>
        </div>
      )}
    </div>
  );
}
