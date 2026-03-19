import { daemonUrl } from "../../shared/config";

export async function tokensCommand(): Promise<void> {
  try {
    const res = await fetch(daemonUrl("/tokens"));
    const data = (await res.json()) as {
      daily: Array<{
        date: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
      }>;
      totals: {
        total_input: number;
        total_output: number;
        total_cost: number;
      };
    };

    if (data.daily.length === 0) {
      console.log("No token usage recorded yet.");
      return;
    }

    console.log("Token Usage (last 30 days):");
    console.log("-".repeat(70));
    for (const row of data.daily) {
      console.log(
        `  ${row.date}  ${row.model.padEnd(20)}  ${String(row.input_tokens).padStart(8)} in  ${String(row.output_tokens).padStart(8)} out  $${row.cost_usd.toFixed(4)}`
      );
    }

    console.log("-".repeat(70));
    console.log(
      `  Total: ${String(data.totals.total_input).padStart(8)} in  ${String(data.totals.total_output).padStart(8)} out  $${data.totals.total_cost.toFixed(4)}`
    );
  } catch (err) {
    if ((err as Error).message?.includes("ECONNREFUSED")) {
      console.error("Daemon is not running. Start it with: hoto daemon start");
    } else {
      console.error(`Failed: ${err}`);
    }
    process.exit(1);
  }
}
