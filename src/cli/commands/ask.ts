import { daemonUrl } from "../../shared/config";

export async function askCommand(args: string[]): Promise<void> {
  let query: string | null = null;
  let repoName: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r" || arg === "--repo") {
      repoName = args[++i];
    } else if (!query && !arg.startsWith("-")) {
      query = arg;
    }
  }

  if (!query) {
    console.log("Usage: hoto ask \"question\" [-r repo]");
    process.exit(1);
  }

  try {
    const res = await fetch(daemonUrl("/knowledge/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        repo_name: repoName ?? undefined,
        limit: 5,
      }),
    });

    if (!res.ok) {
      const err = (await res.json()) as { error: string };
      console.error(`Error: ${err.error}`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      results: Array<{
        repo_name: string;
        source_file: string;
        chunk_type: string;
        title: string;
        content: string;
        score: number;
        match_type: string;
      }>;
      count: number;
    };

    if (data.count === 0) {
      console.log("No results found. Try indexing repos first: hoto repos reindex");
      return;
    }

    console.log(`Found ${data.count} result(s):\n`);
    for (const r of data.results) {
      const score = (r.score * 100).toFixed(0);
      console.log(`--- [${r.repo_name}] ${r.title} (${r.chunk_type}, ${r.match_type} ${score}%) ---`);
      console.log(`  File: ${r.source_file}`);
      // Show first 500 chars of content
      const preview = r.content.length > 500 ? `${r.content.slice(0, 500)}...` : r.content;
      console.log(preview);
      console.log();
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
