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
    console.log("No repos tracked. Add one with: hoto repos add <url>");
    return;
  }

  console.log("Tracked repos:");
  for (const r of repos) {
    const lang = r.language ? ` (${r.language})` : "";
    console.log(`  ${r.name}${lang} -> ${r.path}`);
  }
}

async function addRepo(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    console.log(
      "Usage: hoto repos add <git-url-or-path> [--name name] [--ssh-key <key-path>] [--allow-ci-on-host]\n" +
      "       URL may contain env var tokens: https://$TOKEN@host/org/repo.git\n" +
      "       --ssh-key: path to SSH private key for SSH clone URLs (env vars expanded, not persisted)"
    );
    process.exit(1);
  }

  let name: string | undefined;
  let ciOnHost = false;
  let sshKey = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" || args[i] === "-n") {
      name = args[++i];
    } else if (args[i] === "--allow-ci-on-host") {
      ciOnHost = true;
    } else if (args[i] === "--ssh-key") {
      sshKey = args[++i];
    }
  }

  // Detect if target is a URL or local path
  const isUrl = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("git@") || target.includes("://") || /^\$\{?\w/.test(target);
  const body: Record<string, string | boolean> = isUrl ? { url: target } : { path: target };
  if (name) body.name = name;
  if (ciOnHost) body.ci_on_host = true;

  if (sshKey) {
    const exists = await Bun.file(sshKey).exists();
    if (!exists) {
      console.error(`Error: SSH key not found: ${sshKey}`);
      process.exit(1);
    }
    body.ssh_key_path = sshKey;
  }

  console.log(`Cloning ${target}...`);

  const res = await fetch(daemonUrl("/repos"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    console.error(`Error: ${err.error}`);
    process.exit(1);
  }

  const repo = (await res.json()) as { id: number; name: string; path: string; language?: string; framework?: string };
  const info = [repo.name];
  if (repo.language) info.push(`(${repo.language})`);
  if (repo.framework) info.push(`[${repo.framework}]`);
  console.log(`Repo added: ${info.join(" ")} -> ${repo.path}`);
  await reindexSingle(repo.name);
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
