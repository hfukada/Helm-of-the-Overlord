import { daemonUrl } from "../../shared/config";

export async function askCommand(args: string[]): Promise<void> {
  let query: string | null = null;
  let repoName: string | null = null;
  let showSources = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r" || arg === "--repo") {
      repoName = args[++i];
    } else if (arg === "-s" || arg === "--sources") {
      showSources = true;
    } else if (!query && !arg.startsWith("-")) {
      query = arg;
    }
  }

  if (!query) {
    console.log("Usage: hoto ask \"question\" [-r repo] [-s|--sources]");
    process.exit(1);
  }

  try {
    const res = await fetch(daemonUrl("/knowledge/ask"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        repo_name: repoName ?? undefined,
        limit: 8,
      }),
    });

    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`Error: unexpected response from daemon:\n${text.slice(0, 500)}`);
      process.exit(1);
    }

    if (!res.ok) {
      console.error(`Error: ${(data as { error?: string }).error ?? text.slice(0, 500)}`);
      process.exit(1);
    }

    const typed = data as {
      answer: string;
      sources: Array<{
        repo_name: string;
        source_file: string;
        chunk_type: string;
        title: string;
        content: string;
        score: number;
        match_type: string;
      }>;
    };

    console.log(typed.answer);

    if (showSources && typed.sources.length > 0) {
      console.log("\nSources:");
      for (const r of typed.sources) {
        const score = (r.score * 100).toFixed(0);
        const label = r.title || r.source_file;
        console.log(`  [${r.repo_name}] ${r.source_file} - ${label} (${r.match_type} ${score}%)`);
      }
    }
  } catch (err) {
    if ((err as Error).message?.includes("ECONNREFUSED")) {
      console.error("Daemon is not running. Start it with: hoto daemon start");
    } else {
      console.error(`Failed: ${err}`);
    }
    process.exit(1);
  }
}
