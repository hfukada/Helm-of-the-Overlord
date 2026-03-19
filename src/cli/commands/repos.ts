import { daemonUrl } from "../../shared/config";

export async function reposCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "list";

  try {
    switch (subcommand) {
      case "list":
        await listRepos();
        break;
      case "add":
        await addRepo(args.slice(1));
        break;
      case "remove":
        await removeRepo(args[1]);
        break;
      case "reindex":
        await reindexRepo(args[1]);
        break;
      default:
        console.log("Usage: hoto repos [list|add|remove|reindex]");
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

async function listRepos(): Promise<void> {
  const res = await fetch(daemonUrl("/repos"));
  const repos = (await res.json()) as Array<{
    id: number;
    name: string;
    path: string;
    language: string | null;
  }>;

  if (repos.length === 0) {
    console.log("No repos tracked. Add one with: hoto repos add /path/to/repo");
    return;
  }

  console.log("Tracked repos:");
  for (const r of repos) {
    const lang = r.language ? ` (${r.language})` : "";
    console.log(`  ${r.name}${lang} -> ${r.path}`);
  }
}

async function addRepo(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    console.log("Usage: hoto repos add /path/to/repo [--name name]");
    process.exit(1);
  }

  let name: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" || args[i] === "-n") {
      name = args[++i];
    }
  }

  const res = await fetch(daemonUrl("/repos"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    console.error(`Error: ${err.error}`);
    process.exit(1);
  }

  const repo = (await res.json()) as { id: number; name: string; path: string };
  console.log(`Repo added: ${repo.name} -> ${repo.path}`);
}

async function removeRepo(name: string | undefined): Promise<void> {
  if (!name) {
    console.log("Usage: hoto repos remove <name>");
    process.exit(1);
  }

  const res = await fetch(daemonUrl(`/repos/${name}`), { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    console.error(`Error: ${err.error}`);
    process.exit(1);
  }

  console.log(`Repo removed: ${name}`);
}

async function reindexRepo(name: string | undefined): Promise<void> {
  if (!name) {
    // Reindex all repos
    const listRes = await fetch(daemonUrl("/repos"));
    const repos = (await listRes.json()) as Array<{ name: string }>;
    if (repos.length === 0) {
      console.log("No repos to reindex.");
      return;
    }
    for (const repo of repos) {
      await reindexSingle(repo.name);
    }
    return;
  }

  await reindexSingle(name);
}

async function reindexSingle(name: string): Promise<void> {
  console.log(`Indexing ${name}...`);
  const res = await fetch(daemonUrl(`/knowledge/repos/${name}/reindex`), {
    method: "POST",
  });

  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    console.error(`Error: ${err.error}`);
    return;
  }

  const data = (await res.json()) as {
    repo: string;
    chunks_indexed: number;
    embeddings_generated: number;
  };
  console.log(
    `  ${data.repo}: ${data.chunks_indexed} chunks indexed, ${data.embeddings_generated} embeddings generated`
  );
}
