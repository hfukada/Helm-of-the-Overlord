import { daemonUrl } from "../../shared/config";

export async function statusCommand(args: string[]): Promise<void> {
  const taskId = args[0];

  try {
    if (taskId) {
      await showTaskDetail(taskId);
    } else {
      await listTasks();
    }
  } catch (err) {
    if ((err as Error).message?.includes("ECONNREFUSED")) {
      console.error("Daemon is not running. Start it with: hoto daemon start");
    } else {
      console.error(`Failed to get status: ${err}`);
    }
    process.exit(1);
  }
}

async function listTasks(): Promise<void> {
  const res = await fetch(daemonUrl("/tasks"));
  const tasks = (await res.json()) as Array<{
    id: string;
    title: string;
    status: string;
    created_at: string;
  }>;

  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log("Tasks:");
  console.log("-".repeat(80));
  for (const t of tasks) {
    const status = t.status.toUpperCase().padEnd(14);
    console.log(`  ${t.id}  ${status}  ${t.title}`);
  }
}

async function showTaskDetail(taskId: string): Promise<void> {
  const res = await fetch(daemonUrl(`/tasks/${taskId}`));
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    console.error(`Error: ${err.error}`);
    process.exit(1);
  }

  const task = (await res.json()) as {
    id: string;
    title: string;
    description: string;
    status: string;
    branch_name: string | null;
    created_at: string;
    updated_at: string;
    agent_runs: Array<{
      node_name: string;
      status: string;
      token_input: number;
      token_output: number;
      cost_usd: number;
      model: string;
      error: string | null;
    }>;
    diff: string | null;
    diff_summary: Array<{ file: string; insertions: number; deletions: number }> | null;
  };

  console.log(`Task: ${task.id}`);
  console.log(`Title: ${task.title}`);
  console.log(`Status: ${task.status}`);
  if (task.branch_name) console.log(`Branch: ${task.branch_name}`);
  console.log(`Created: ${task.created_at}`);
  console.log(`Updated: ${task.updated_at}`);

  if (task.agent_runs.length > 0) {
    console.log("\nAgent Runs:");
    console.log("-".repeat(60));
    let totalCost = 0;
    for (const run of task.agent_runs) {
      const status = run.status.toUpperCase().padEnd(10);
      const tokens = `${run.token_input}/${run.token_output} tokens`;
      const cost = `$${run.cost_usd.toFixed(4)}`;
      console.log(`  ${run.node_name.padEnd(12)} ${status} ${tokens.padEnd(24)} ${cost}  (${run.model})`);
      if (run.error) {
        console.log(`    Error: ${run.error}`);
      }
      totalCost += run.cost_usd;
    }
    console.log(`${"".padEnd(50)} Total: $${totalCost.toFixed(4)}`);
  }

  if (task.diff_summary?.length) {
    console.log("\nChanged Files:");
    console.log("-".repeat(60));
    for (const f of task.diff_summary) {
      console.log(`  +${f.insertions} -${f.deletions}\t${f.file}`);
    }
  }

  if (task.diff) {
    console.log("\nDiff:");
    console.log("=".repeat(80));
    console.log(task.diff);
  }
}
