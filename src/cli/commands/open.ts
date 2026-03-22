import { $ } from "bun";
import { daemonUrl } from "../../shared/config";
import { config } from "../../shared/config";

export async function openCommand(args: string[]): Promise<void> {
  const taskId = args[0];

  // Verify daemon is running
  try {
    await fetch(daemonUrl("/health"));
  } catch {
    console.error("Daemon is not running. Start it with: hoto daemon start");
    process.exit(1);
  }

  let url: string;

  if (taskId) {
    // Try to get the Gitea PR URL for this task
    try {
      const res = await fetch(daemonUrl(`/tasks/${taskId}`));
      if (res.ok) {
        const task = await res.json() as { gitea_pr_url?: string };
        if (task.gitea_pr_url) {
          url = task.gitea_pr_url;
        } else {
          // Fall back to API URL
          url = daemonUrl(`/tasks/${taskId}`);
        }
      } else {
        console.error("Task not found");
        process.exit(1);
      }
    } catch {
      url = daemonUrl(`/tasks/${taskId}`);
    }
  } else if (config.giteaUrl) {
    // Open the Gitea org page
    url = `${config.giteaUrl}/${config.giteaOrg}`;
  } else {
    url = daemonUrl("/health");
  }

  console.log(`Opening ${url}`);

  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await $`open ${url}`.quiet();
    } else if (platform === "win32") {
      await $`cmd /c start ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
  } catch {
    console.log(`Open this URL in your browser: ${url}`);
  }
}
