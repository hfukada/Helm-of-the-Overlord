const STATUS_COLORS: Record<string, string> = {
  pending: "bg-slate-600 text-slate-100",
  indexing: "bg-sky-600 text-white",
  planning: "bg-blue-600 text-white",
  implementing: "bg-indigo-600 text-white",
  linting: "bg-amber-600 text-white",
  ci_running: "bg-amber-600 text-white",
  ci_fixing: "bg-orange-600 text-white",
  review: "bg-violet-600 text-white",
  accepted: "bg-emerald-600 text-white",
  committed: "bg-emerald-700 text-white",
  failed: "bg-red-600 text-white",
  cancelled: "bg-slate-700 text-slate-300",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  indexing: "Indexing",
  planning: "Planning",
  implementing: "Implementing",
  linting: "Linting",
  ci_running: "CI Running",
  ci_fixing: "CI Fixing",
  review: "Review",
  accepted: "Accepted",
  committed: "Committed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-600 text-gray-200";
  const label = STATUS_LABELS[status] ?? status;

  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {label}
    </span>
  );
}
