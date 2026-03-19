const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-600 text-gray-200",
  indexing: "bg-blue-600 text-blue-100",
  planning: "bg-blue-600 text-blue-100",
  implementing: "bg-blue-600 text-blue-100",
  linting: "bg-yellow-600 text-yellow-100",
  ci_running: "bg-yellow-600 text-yellow-100",
  ci_fixing: "bg-yellow-600 text-yellow-100",
  review: "bg-purple-600 text-purple-100",
  accepted: "bg-green-600 text-green-100",
  committed: "bg-green-700 text-green-100",
  failed: "bg-red-600 text-red-100",
  cancelled: "bg-gray-700 text-gray-300",
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
