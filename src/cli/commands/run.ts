import { readFile } from "node:fs/promises";
import { daemonUrl } from "../../shared/config";

export async function runCommand(args: string[]): Promise<void> {
  let description: string | null = null;
  const repoNames: string[] = [];
  let file: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r" || arg === "--repo") {
      repoNames.push(args[++i]);
    } else if (arg === "-f" || arg === "--file") {
      file = args[++i];
    } else if (!description && !arg.startsWith("-")) {
      description = arg;
    }
  }

  if (file) {
    description = await readFile(file, "utf-8");
  }

  if (!description) {
    console.log("Usage: hoto run \"task description\" [-r repo [-r repo2]] [-f file]");
    process.exit(1);
  }

  // Build request body -- use repo_names for multi, repo_name for single (backward compat)
  const reqBody: Record<string, unknown> = { description, source: "cli" };
  if (repoNames.length > 1) {
    reqBody.repo_names = repoNames;
  } else if (repoNames.length === 1) {
    reqBody.repo_name = repoNames[0];
  }

  try {
    const res = await fetch(daemonUrl("/tasks"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error(`Error: ${(err as { error: string }).error}`);
      process.exit(1);
    }

    const task = (await res.json()) as { id: string; title: string; status: string };
    console.log(`Task submitted: ${task.id}`);
    console.log(`Title: ${task.title}`);
    console.log(`Status: ${task.status}`);
    console.log(`\nTrack progress: hoto status ${task.id}`);
  } catch (err) {
    if ((err as Error).message?.includes("ECONNREFUSED")) {
      console.error("Daemon is not running. Start it with: hoto daemon start");
    } else {
      console.error(`Failed to submit task: ${err}`);
    }
    process.exit(1);
  }
}
