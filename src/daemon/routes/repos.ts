import { Hono } from "hono";
import { join } from "node:path";
import { $ } from "bun";
import { getDb } from "../../knowledge/db";
import { deleteCollection } from "../../knowledge/chromadb";
import { logger } from "../../shared/logger";
import { config } from "../../shared/config";
import { parseRepo } from "../../knowledge/repo-parser";
import { indexRepo } from "../../knowledge/indexer";
import type { Repo } from "../../shared/types";
import { embedGiteaCredentials, mirrorRepoToGitea, isGiteaConfigured } from "../../gitea/client";
import { getMessagingManager } from "../../messaging/manager";

const repos = new Hono();

repos.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM repos WHERE archived = 0 ORDER BY name").all();
  return c.json(rows);
});

repos.post("/", async (c) => {
  const body = await c.req.json<{
    url?: string;
    path?: string;
    name?: string;
    description?: string;
    language?: string;
    framework?: string;
    build_cmd?: string;
    test_cmd?: string;
    run_cmd?: string;
    lint_cmd?: string;
    ci_on_host?: boolean;
    extra_context?: string | null;
  }>();

  if (!body.url && !body.path) {
    return c.json({ error: "Either 'url' (git clone URL) or 'path' (local path) is required" }, 400);
  }

  let repoPath: string;
  let name: string;

  if (body.url) {
    // Derive name from URL if not provided
    name = body.name ?? body.url.split("/").pop()?.replace(/\.git$/, "") ?? "unknown";

    // Clone into workspace/repos/<name>
    const reposDir = join(config.workspaceDir, "repos");
    repoPath = join(reposDir, name);

    const db = getDb();
    const existing = db.query("SELECT id, archived FROM repos WHERE name = ?").get(name) as { id: number; archived: number } | null;
    if (existing) {
      if (existing.archived) {
        // Unarchive the existing repo instead of re-cloning
        db.run("UPDATE repos SET archived = 0 WHERE id = ?", [existing.id]);
        logger.info("Repo unarchived", { name });
        return c.json({ id: existing.id, name, unarchived: true }, 200);
      }
      return c.json({ error: `Repo '${name}' already exists` }, 409);
    }

    try {
      await $`mkdir -p ${reposDir}`.quiet();
      await $`rm -rf ${repoPath}`.quiet();
      const cloneUrl = embedGiteaCredentials(body.url);
      logger.info("Cloning repo", { url: body.url, dest: repoPath });
      const result = await $`git clone ${cloneUrl} ${repoPath}`.nothrow().quiet();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        logger.error("Clone failed", { url: body.url, exitCode: result.exitCode, stderr });
        return c.json({ error: `Clone failed: ${stderr || `exit code ${result.exitCode}`}` }, 500);
      }

      // If the source URL is not from this Gitea instance, mirror it up to Gitea
      if (isGiteaConfigured() && embedGiteaCredentials(body.url) === body.url) {
        await mirrorRepoToGitea(repoPath, name);
      }
    } catch (err) {
      logger.error("Clone or mirror failed", { url: body.url, error: String(err) });
      await $`rm -rf ${repoPath}`.quiet();
      return c.json({ error: `Clone failed: ${String(err)}` }, 500);
    }
  } else {
    // Legacy local path mode
    const { resolve } = await import("node:path");
    repoPath = resolve(body.path ?? "");
    name = body.name ?? repoPath.split("/").pop() ?? "unknown";
  }

  const db = getDb();

  // Check for duplicates (for local path mode -- URL mode already checked)
  if (body.path) {
    const existing = db.query("SELECT id FROM repos WHERE name = ?").get(name);
    if (existing) {
      return c.json({ error: `Repo '${name}' already exists` }, 409);
    }
  }

  // Auto-detect repo metadata
  const parsed = await parseRepo(repoPath);

  const result = db.run(
    `INSERT INTO repos (name, path, description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, docker_compose_path, docker_image, ci_on_host, extra_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      repoPath,
      body.description ?? parsed.description,
      body.language ?? parsed.language,
      body.framework ?? parsed.framework,
      body.build_cmd ?? parsed.build_cmd,
      body.test_cmd ?? parsed.test_cmd,
      body.run_cmd ?? parsed.run_cmd,
      body.lint_cmd ?? parsed.lint_cmd,
      parsed.docker_compose_path,
      parsed.docker_image,
      body.ci_on_host ? 1 : 0,
      body.extra_context ?? null,
    ]
  );

  const repoId = Number(result.lastInsertRowid);
  logger.info("Repo added", { name, path: repoPath, language: parsed.language });

  // Auto-index in background
  const repo: Repo = {
    id: repoId, name, path: repoPath,
    description: body.description ?? parsed.description,
    build_cmd: body.build_cmd ?? parsed.build_cmd,
    test_cmd: body.test_cmd ?? parsed.test_cmd,
    run_cmd: body.run_cmd ?? parsed.run_cmd,
    lint_cmd: body.lint_cmd ?? parsed.lint_cmd,
    language: body.language ?? parsed.language,
    framework: body.framework ?? parsed.framework,
    docker_compose_path: parsed.docker_compose_path,
    docker_image: parsed.docker_image,
    ci_on_host: body.ci_on_host ?? false,
    metadata: null,
    extra_context: body.extra_context ?? null,
  };
  indexRepo(repo)
    .then((result) => {
      getMessagingManager()?.notifyIndexingComplete(repo.name, result.chunks, result.embeddings);
    })
    .catch((err) => {
      logger.warn("Auto-indexing failed", { repo: name, error: String(err) });
    });

  return c.json({
    id: repoId, name, path: repoPath,
    language: body.language ?? parsed.language,
    framework: body.framework ?? parsed.framework,
  }, 201);
});

repos.patch("/:name", async (c) => {
  const name = c.req.param("name");
  const db = getDb();

  const existing = db.query("SELECT id FROM repos WHERE name = ? AND archived = 0").get(name) as { id: number } | null;
  if (!existing) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const body = await c.req.json<{
    description?: string | null;
    language?: string | null;
    framework?: string | null;
    build_cmd?: string | null;
    test_cmd?: string | null;
    run_cmd?: string | null;
    lint_cmd?: string | null;
    ci_on_host?: boolean;
    extra_context?: string | null;
  }>();

  const allowed = ["description", "language", "framework", "build_cmd", "test_cmd", "run_cmd", "lint_cmd", "ci_on_host", "extra_context"] as const;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = ?`);
      values.push(key === "ci_on_host" ? (body[key] ? 1 : 0) : body[key] ?? null);
    }
  }

  if (sets.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  values.push(existing.id);
  db.run(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`, values);

  const updated = db.query("SELECT * FROM repos WHERE id = ?").get(existing.id);
  logger.info("Repo updated", { name, fields: sets.map((s) => s.split(" ")[0]) });
  return c.json(updated);
});

repos.delete("/:name", async (c) => {
  const name = c.req.param("name");
  const db = getDb();

  const repo = db.query("SELECT id FROM repos WHERE name = ? AND archived = 0").get(name) as { id: number } | null;
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const TERMINAL = ["committed", "failed", "cancelled"];
  const placeholders = TERMINAL.map(() => "?").join(", ");
  const active = db.query(
    `SELECT 1 FROM tasks t
     JOIN task_repos tr ON tr.task_id = t.id
     WHERE tr.repo_id = ? AND t.status NOT IN (${placeholders})
     LIMIT 1`
  ).get(repo.id, ...TERMINAL) as unknown;
  if (active) {
    return c.json({ error: "Repo has active tasks" }, 409);
  }

  db.run("DELETE FROM repos WHERE id = ?", [repo.id]);
  await deleteCollection(name);
  logger.info("Repo deleted", { name });
  return c.json({ deleted: name });
});

repos.post("/init", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const db = getDb();
  const existing = db.query("SELECT id FROM repos WHERE name = ?").get(name);
  if (existing) {
    return c.json({ error: `Repo '${name}' already exists` }, 409);
  }

  const reposDir = join(config.workspaceDir, "repos");
  const repoPath = join(reposDir, name);

  await $`mkdir -p ${repoPath}`.quiet();

  const initResult = await $`git init ${repoPath}`.nothrow().quiet();
  if (initResult.exitCode !== 0) {
    const stderr = initResult.stderr.toString().trim();
    logger.error("git init failed", { name, exitCode: initResult.exitCode, stderr });
    return c.json({ error: `git init failed: ${stderr || `exit code ${initResult.exitCode}`}` }, 500);
  }

  const commitResult = await $`git -C ${repoPath} commit --allow-empty -m "init"`.nothrow().quiet();
  if (commitResult.exitCode !== 0) {
    const stderr = commitResult.stderr.toString().trim();
    logger.error("Initial commit failed", { name, exitCode: commitResult.exitCode, stderr });
    await $`rm -rf ${repoPath}`.quiet();
    return c.json({ error: `Initial commit failed: ${stderr || `exit code ${commitResult.exitCode}`}` }, 500);
  }

  const parsed = await parseRepo(repoPath);

  const result = db.run(
    `INSERT INTO repos (name, path, description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, docker_compose_path, docker_image, ci_on_host, extra_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      repoPath,
      parsed.description,
      parsed.language,
      parsed.framework,
      parsed.build_cmd,
      parsed.test_cmd,
      parsed.run_cmd,
      parsed.lint_cmd,
      parsed.docker_compose_path,
      parsed.docker_image,
      0,
      null,
    ]
  );

  const repoId = Number(result.lastInsertRowid);
  logger.info("Repo initialized", { name, path: repoPath, language: parsed.language });

  const repo: Repo = {
    id: repoId, name, path: repoPath,
    description: parsed.description,
    build_cmd: parsed.build_cmd,
    test_cmd: parsed.test_cmd,
    run_cmd: parsed.run_cmd,
    lint_cmd: parsed.lint_cmd,
    language: parsed.language,
    framework: parsed.framework,
    docker_compose_path: parsed.docker_compose_path,
    docker_image: parsed.docker_image,
    ci_on_host: false,
    metadata: null,
    extra_context: null,
  };
  indexRepo(repo)
    .then((r) => {
      getMessagingManager()?.notifyIndexingComplete(repo.name, r.chunks, r.embeddings);
    })
    .catch((err) => {
      logger.warn("Auto-indexing failed", { repo: name, error: String(err) });
    });

  return c.json({ id: repoId, name, path: repoPath }, 201);
});

export { repos };
