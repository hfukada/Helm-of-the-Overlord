import { $ } from "bun";
import { daemonUrl } from "../../shared/config";

export async function openCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const path = taskId ? `/app/tasks/${taskId}` : "/app/";
  const url = daemonUrl(path);

  // Verify daemon is running
  try {
    await fetch(daemonUrl("/health"));
  } catch {
    console.error("Daemon is not running. Start it with: hoto daemon start");
    process.exit(1);
  }

  console.log(`Opening ${url}`);

  // Open browser (cross-platform)
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
