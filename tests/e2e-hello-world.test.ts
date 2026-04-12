/**
 * End-to-end integration test: register an empty git repo, submit a
 * hello-world task, and verify the full pipeline produced a committed
 * main.py that prints "hello world".
 *
 * This test runs a REAL Claude CLI subprocess against REAL ChromaDB and
 * Ollama. It is intentionally NOT part of the default test suite:
 *
 *   - Auto-skips if `claude` is not on PATH
 *   - Auto-skips if ChromaDB or Ollama are unreachable
 *   - Auto-skips if `python3` is not on PATH
 *   - Driven by `bun run test:e2e`, not `bun run test`
 *
 * The test drives runTask() directly in-process to avoid conflicting with a
 * locally running daemon. It seeds the DB with a repo and task row, then
 * awaits runTask to completion.
 */
import { ulid } from "ulid";

// Must be set BEFORE importing any hoto module so config picks it up.
const WORKSPACE = `/tmp/hoto-e2e-${ulid()}`;
process.env.HOTO_WORKSPACE = WORKSPACE;
// Force the no-Gitea path so children terminate on local commit.
delete process.env.GITEA_URL;
// Run claude on the host, not in a Docker sandbox.
process.env.HOTO_SANDBOX_CLAUDE = "false";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

// Probes -- decide whether to skip the whole describe block.
async function hasBinary(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn([name, "--version"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

const hasClaude = await hasBinary("claude");
const hasPython = await hasBinary("python3");

let chromaOk = false;
let ollamaOk = false;
if (hasClaude && hasPython) {
  mkdirSync(WORKSPACE, { recursive: true });
  const { isChromaAvailable } = await import("../src/knowledge/chromadb");
  const { isOllamaAvailable } = await import("../src/knowledge/embeddings");
  chromaOk = await isChromaAvailable();
  ollamaOk = await isOllamaAvailable();
}

const shouldRun = hasClaude && hasPython && chromaOk && ollamaOk;
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E("e2e hello-world", () => {
  const REPO_NAME = "hoto-e2e-test-repo";
  const repoPath = join(WORKSPACE, "source-repo");
  const taskId = ulid();
  let repoId = 0;

  beforeAll(async () => {
    // 1. Fresh git repo on disk
    mkdirSync(repoPath, { recursive: true });
    await $`git -C ${repoPath} init -q -b main`;
    await $`git -C ${repoPath} config user.email "e2e@hoto.test"`;
    await $`git -C ${repoPath} config user.name "hoto e2e"`;
    // Initial commit so the branch exists -- hoto's createTaskClone clones
    // and expects a real head to branch off.
    await Bun.write(join(repoPath, "README.md"), "# e2e test repo\n");
    await $`git -C ${repoPath} add -A`;
    await $`git -C ${repoPath} commit -q -m "initial"`;

    // 2. Seed DB directly -- mirrors the work POST /repos and POST /tasks do.
    const { getDb } = await import("../src/knowledge/db");
    const { parseRepo } = await import("../src/knowledge/repo-parser");
    const db = getDb();

    const parsed = await parseRepo(repoPath);
    const result = db.run(
      `INSERT INTO repos (name, path, description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, docker_compose_path, docker_image, ci_on_host)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        REPO_NAME,
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
      ]
    );
    repoId = Number(result.lastInsertRowid);

    const description = `Create a file main.py at the repo root that prints "hello world" when run with python3. No other files.`;
    db.run(
      `INSERT INTO tasks (id, title, description, repo_id, source)
       VALUES (?, ?, ?, ?, 'cli')`,
      [taskId, "e2e hello world", description, repoId]
    );
    db.run(
      "INSERT INTO task_repos (task_id, repo_id, role) VALUES (?, ?, 'target')",
      [taskId, repoId]
    );
  });

  afterAll(async () => {
    // Keep workspace on failure for postmortem; set HOTO_E2E_KEEP=1 to always keep.
    if (!process.env.HOTO_E2E_KEEP) {
      await rm(WORKSPACE, { recursive: true, force: true });
    } else {
      // eslint-disable-next-line no-console
      console.log(`[e2e-hello-world] keeping workspace: ${WORKSPACE}`);
    }
  });

  test(
    "produces a working main.py committed to the task branch",
    async () => {
      const { runTask, loadTaskAndRepos } = await import("../src/orchestrator/task-runner");
      const { getDb } = await import("../src/knowledge/db");
      const { taskDir } = await import("../src/workspace/manager");

      await runTask(taskId);

      // Parent task should be committed.
      const parent = getDb()
        .query("SELECT status FROM tasks WHERE id = ?")
        .get(taskId) as { status: string } | null;
      expect(parent).not.toBeNull();
      expect(parent?.status).toBe("committed");

      // Exactly one child, also committed.
      const children = getDb()
        .query("SELECT id, status FROM child_tasks WHERE parent_task_id = ?")
        .all(taskId) as Array<{ id: string; status: string }>;
      expect(children.length).toBe(1);
      expect(children[0].status).toBe("committed");

      // The child's worktree lives at <taskDir>/<repoName>/.
      const loaded = loadTaskAndRepos(taskId);
      expect(loaded).not.toBeNull();
      const wd = join(taskDir(taskId), REPO_NAME);

      // 1. main.py exists.
      const mainPy = join(wd, "main.py");
      expect(existsSync(mainPy)).toBe(true);

      // 2. python3 main.py prints something containing "hello world".
      const out = (await $`python3 ${mainPy}`.text()).toLowerCase();
      expect(out).toContain("hello world");

      // 3. git log on the task branch contains a hoto commit.
      const log = await $`git -C ${wd} log --oneline`.text();
      expect(log).toMatch(/hoto:/);
    },
    15 * 60 * 1000 // 15-minute timeout for the full real-claude pipeline
  );
});

if (!shouldRun) {
  // Surface the reason in the test output so a skipped run is easy to diagnose.
  const missing: string[] = [];
  if (!hasClaude) missing.push("claude CLI");
  if (!hasPython) missing.push("python3");
  if (!chromaOk) missing.push("ChromaDB");
  if (!ollamaOk) missing.push("Ollama");
  // eslint-disable-next-line no-console
  console.log(`[e2e-hello-world] SKIPPED -- missing: ${missing.join(", ")}`);
}
