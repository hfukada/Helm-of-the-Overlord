import { runCommand } from "./commands/run";
import { statusCommand } from "./commands/status";
import { daemonCommand } from "./commands/daemon";
import { reposCommand } from "./commands/repos";
import { tokensCommand } from "./commands/tokens";
import { askCommand } from "./commands/ask";
import { openCommand } from "./commands/open";

const HELP = `
hoto -- multi-repo task manager

Usage:
  hoto "task description"           Submit a task
  hoto -f task.txt                  Submit from file
  hoto -f task.txt -r repo-name    Target specific repo
  hoto status                       List tasks
  hoto status <id>                  Task detail + diff
  hoto cancel <id>                  Cancel a task
  hoto ask "question" [-r repo]     Query knowledge base
  hoto repos                        List tracked repos
  hoto repos add /path/to/repo     Add + index repo
  hoto repos remove <name>          Untrack repo
  hoto repos reindex [name]         Re-index repo knowledge
  hoto tokens                       Token usage summary
  hoto open [task-id]               Open web UI in browser
  hoto daemon start|stop|status    Daemon management
  hoto help                         Show this help
`.trim();

export async function runCli(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "daemon":
      await daemonCommand(args.slice(1));
      break;
    case "status":
      await statusCommand(args.slice(1));
      break;
    case "cancel": {
      const id = args[1];
      if (!id) {
        console.log("Usage: hoto cancel <task-id>");
        process.exit(1);
      }
      const { daemonUrl } = await import("../shared/config");
      try {
        const res = await fetch(daemonUrl(`/tasks/${id}/cancel`), { method: "POST" });
        if (!res.ok) {
          const err = (await res.json()) as { error: string };
          console.error(`Error: ${err.error}`);
          process.exit(1);
        }
        console.log(`Task ${id} cancelled.`);
      } catch {
        console.error("Daemon is not running. Start it with: hoto daemon start");
        process.exit(1);
      }
      break;
    }
    case "ask":
      await askCommand(args.slice(1));
      break;
    case "open":
      await openCommand(args.slice(1));
      break;
    case "repos":
      await reposCommand(args.slice(1));
      break;
    case "tokens":
      await tokensCommand();
      break;
    default:
      // Anything else is treated as a task description
      await runCommand(args);
      break;
  }
}
