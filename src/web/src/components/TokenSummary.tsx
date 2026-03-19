import { useEffect, useState } from "react";
import { fetchTokens, type TokenUsageResponse } from "../api";

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function TokenSummary() {
  const [data, setData] = useState<TokenUsageResponse | null>(null);

  useEffect(() => {
    const load = () => fetchTokens().then(setData).catch(() => {});
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (!data) return <div className="text-sm text-gray-500">Loading...</div>;

  return (
    <div>
      {/* Totals */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-sm text-gray-400">Total Input</div>
          <div className="text-xl font-bold">
            {formatTokens(data.totals.total_input)}
          </div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-sm text-gray-400">Total Output</div>
          <div className="text-xl font-bold">
            {formatTokens(data.totals.total_output)}
          </div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-sm text-gray-400">Total Cost</div>
          <div className="text-xl font-bold">
            {formatCost(data.totals.total_cost)}
          </div>
        </div>
      </div>

      {/* Daily table */}
      {data.daily.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left text-gray-400">
              <th className="pb-2">Date</th>
              <th className="pb-2">Model</th>
              <th className="pb-2 text-right">Input</th>
              <th className="pb-2 text-right">Output</th>
              <th className="pb-2 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((row, i) => (
              <tr key={i} className="border-b border-gray-800">
                <td className="py-1.5">{row.date}</td>
                <td className="py-1.5 text-gray-400">{row.model}</td>
                <td className="py-1.5 text-right">
                  {formatTokens(row.input_tokens)}
                </td>
                <td className="py-1.5 text-right">
                  {formatTokens(row.output_tokens)}
                </td>
                <td className="py-1.5 text-right">
                  {formatCost(row.cost_usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Inline token summary for a task's agent runs */
export function TaskTokenSummary({
  runs,
}: {
  runs: Array<{
    token_input: number;
    token_output: number;
    cost_usd: number;
  }>;
}) {
  const totals = runs.reduce(
    (acc, r) => ({
      input: acc.input + r.token_input,
      output: acc.output + r.token_output,
      cost: acc.cost + r.cost_usd,
    }),
    { input: 0, output: 0, cost: 0 }
  );

  return (
    <span className="text-xs text-gray-400">
      {formatTokens(totals.input)} in / {formatTokens(totals.output)} out /{" "}
      {formatCost(totals.cost)}
    </span>
  );
}
