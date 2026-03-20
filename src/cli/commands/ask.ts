import { daemonUrl } from "../../shared/config";

type SourceEntry = {
  repo_name: string;
  source_file: string;
  chunk_type: string;
  title: string;
  content: string;
  score: number;
  match_type: string;
};

type NdjsonLine =
  | { type: "event"; event_type: string; content: string }
  | { type: "done"; answer: string; sources: SourceEntry[] }
  | { type: "error"; message: string };

function renderEvent(eventType: string, content: string, showThinking: boolean): void {
  switch (eventType) {
    case "thinking":
      if (!showThinking) return;
      if (content.trim()) {
        process.stdout.write(
          `[thinking] ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}\n`,
        );
      }
      break;
    case "tool_use":
      process.stdout.write(`[tool: ${content}]\n`);
      break;
    case "tool_result":
      process.stdout.write(
        `[result: ${content.slice(0, 120)}${content.length > 120 ? "..." : ""}]\n`,
      );
      break;
    case "text":
      process.stdout.write(content);
      break;
    default:
      break;
  }
}

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
        stream: true,
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

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sources: SourceEntry[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        let line: NdjsonLine;
        try {
          line = JSON.parse(rawLine) as NdjsonLine;
        } catch {
          continue;
        }

        if (line.type === "event") {
          renderEvent(line.event_type, line.content, showThinking);
        } else if (line.type === "done") {
          sources = line.sources ?? [];
          // answer was already printed via streaming text events; print a
          // newline to terminate the final text chunk if needed
          process.stdout.write("\n");
        } else if (line.type === "error") {
          console.error(`\nError: ${line.message}`);
          process.exit(1);
        }
      }
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
