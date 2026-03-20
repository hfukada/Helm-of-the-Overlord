import { daemonUrl } from "../../shared/config";
import { StreamFormatter } from "../stream-formatter";

type SourceEntry = {
  repo_name: string;
  source_file: string;
  chunk_type: string;
  title: string;
  content: string;
  score: number;
  match_type: string;
};

type PollResponse = {
  status: string;
  events: { id: number; event_type: string; content: string }[];
  answer?: string;
  sources?: SourceEntry[];
  error?: string;
};

export async function askCommand(args: string[]): Promise<void> {
  let query: string | null = null;
  let repoName: string | null = null;
  let showSources = false;
  let showThinking = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r" || arg === "--repo") {
      repoName = args[++i];
    } else if (arg === "-s" || arg === "--sources") {
      showSources = true;
    } else if (arg === "--no-thinking" || arg === "-q" || arg === "--quiet") {
      showThinking = false;
    } else if (!query && !arg.startsWith("-")) {
      query = arg;
    }
  }

  if (!query) {
    console.log("Usage: hoto ask \"question\" [-r repo] [-s|--sources] [--no-thinking]");
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

    if (!res.ok) {
      const text = await res.text();
      let errMsg = text.slice(0, 500);
      try {
        const data = JSON.parse(text) as { error?: string };
        if (data.error) errMsg = data.error;
      } catch {
        // use raw text
      }
      console.error(`Error: ${errMsg}`);
      process.exit(1);
    }

    const data = await res.json() as {
      id: string | null;
      answer?: string;
      sources?: SourceEntry[];
      status?: string;
    };

    // No knowledge found -- immediate answer
    if (data.id === null) {
      console.log(data.answer ?? "");
      return;
    }

    // Poll for streaming events
    const askId = data.id;
    let lastSeenId = 0;
    let sources: SourceEntry[] = [];

    const fmt = new StreamFormatter(showThinking, (output) => {
      switch (output.type) {
        case "thinking":
          process.stdout.write(`[thinking] ${output.content}\n`);
          break;
        case "tool":
          process.stdout.write(`[tool] ${output.content}\n`);
          break;
        case "result":
          process.stdout.write(`[result: ${output.content}]\n`);
          break;
        case "text":
          process.stdout.write(output.content);
          break;
      }
    });

    while (true) {
      const pollRes = await fetch(
        daemonUrl(`/knowledge/ask/${askId}/stream?after=${lastSeenId}`)
      );

      if (!pollRes.ok) {
        console.error(`\nError polling: ${pollRes.status}`);
        process.exit(1);
      }

      const poll = await pollRes.json() as PollResponse;

      for (const event of poll.events) {
        fmt.push(event.event_type, event.content);
        lastSeenId = event.id;
      }

      if (poll.status === "completed") {
        fmt.flush();
        sources = poll.sources ?? [];
        process.stdout.write("\n");
        break;
      }

      if (poll.status === "failed") {
        fmt.flush();
        console.error(`\nError: ${poll.error ?? "unknown error"}`);
        process.exit(1);
      }

      await Bun.sleep(150);
    }

    if (showSources && sources.length > 0) {
      console.log("\nSources:");
      for (const r of sources) {
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
