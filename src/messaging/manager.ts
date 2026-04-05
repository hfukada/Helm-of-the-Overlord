import type { MessagingProvider, CommandEvent, MessageEvent } from "./interface";
import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { config } from "../shared/config";
import type { Task, TaskStatus } from "../shared/types";

const COMMAND_HELP: Record<string, string> = {
  list: [
    "!list",
    "List the 20 most recent tasks with their ID (first 8 chars), status, and title.",
    "Example: !list",
  ].join("\n"),
  status: [
    "!status [id]",
    "Show details for a task. You can use just the first few characters of the ID.",
    "Shows: title, full ID, status, branch name, created/updated timestamps.",
    "Example: !status 01JA3B",
  ].join("\n"),
  cancel: [
    "!cancel [id]",
    "Cancel a running task. Kills subprocesses, tears down containers, removes the worktree.",
    "Cannot cancel tasks already in a terminal state (committed, cancelled).",
    "Example: !cancel 01JA3B",
  ].join("\n"),
  run: [
    "!run <description> [-r repo]",
    "Submit a new task. If only one repo is registered, it is used automatically.",
    "Use -r to specify which repo if multiple are registered.",
    "Examples:",
    "  !run Add a health check endpoint",
    "  !run Fix the login bug -r my-api",
  ].join("\n"),
  repos: [
    "!repos",
    "List all registered repos with their detected language and framework.",
  ].join("\n"),
  "repo": [
    "!repo add <git-url> [--name <name>]",
    "!repo remove <name>",
    "Add or remove a repo.",
    "  add: Clone a git repo and register it. Auto-detects language, framework, and commands.",
    "  remove: Untrack a repo (removes from DB, does not delete files).",
    "Examples:",
    "  !repo add https://github.com/org/project.git",
    "  !repo add git@github.com:org/project.git --name my-project",
    "  !repo remove my-project",
  ].join("\n"),
  reindex: [
    "!reindex <repo>",
    "Re-scan and index a repo's documentation, config files, and key source files.",
    "Updates both SQLite (keyword search) and ChromaDB (vector search).",
    "Example: !reindex my-api",
  ].join("\n"),
  tokens: [
    "!tokens",
    "Show today's token usage broken down by model.",
    "Displays input tokens, output tokens, and estimated cost in USD.",
  ].join("\n"),
  ask: [
    "!ask <question>",
    "Query the knowledge base. Searches indexed repos and uses AI to synthesize an answer.",
    "Plain messages in the main channel also trigger this.",
    "Example: !ask How does authentication work in my-api?",
  ].join("\n"),
  approve: [
    "!approve",
    "Accept the current implementation. Only works in task channels.",
    "If Gitea is configured, this is equivalent to merging the PR.",
  ].join("\n"),
  revise: [
    "!revise <feedback>",
    "Request changes to the implementation. Only works in task channels.",
    "The agent will revise based on your feedback, then re-push for review.",
    "Example: !revise Use a map instead of an array for O(1) lookups",
  ].join("\n"),
  "delete-task": [
    "!delete-task [id]",
    "Delete a task and clean up its working directories and database entries.",
    "In the main channel: !delete-task <id>  (use the first few characters of the ID)",
    "In a task channel:   !delete-task       (no argument needed)",
    "This permanently removes the task, its worktree, agent runs, messages, and channel.",
    "Examples:",
    "  !delete-task 01JA3B",
    "  !delete-task  (from inside the task's channel)",
  ].join("\n"),
  "clean-done": [
    "!clean-done",
    "Delete all finished tasks (status: committed, cancelled, failed).",
    "Kicks all users from each task's Matrix channel, then removes the task and all related DB rows.",
    "Example: !clean-done",
  ].join("\n"),
  relate: [
    "!relate <repo-a> <repo-b> <description>",
    "Define a relationship between two repos. The description explains how they relate.",
    "This context is used by the planner when building cross-repo tasks.",
    "Examples:",
    "  !relate my-api my-frontend frontend consumes the API",
    "  !relate shared-lib my-api shared-lib is a dependency of my-api",
  ].join("\n"),
  unrelate: [
    "!unrelate <repo-a> <repo-b> <relationship-type>",
    "Remove a relationship between two repos.",
    "Example: !unrelate my-api my-frontend depends_on",
  ].join("\n"),
  relationships: [
    "!relationships [repo]",
    "List repo relationships. If a repo name is given, shows only that repo's relationships.",
    "Otherwise shows all relationships.",
    "Example: !relationships my-api",
  ].join("\n"),
  help: [
    "!help [command]",
    "Show the command list, or detailed help for a specific command.",
    "Example: !help run",
  ].join("\n"),
};

export class MessagingManager {
  private provider: MessagingProvider;
  private mainChannelId: string | null = null;
  private taskCreators = new Map<string, string>(); // taskId -> Matrix userId

  constructor(provider: MessagingProvider) {
    this.provider = provider;
  }

  async start(): Promise<void> {
    await this.provider.connect();

    this.provider.onCommand(async (cmd) => {
      try {
        await this.handleCommand(cmd);
      } catch (err) {
        logger.error("Command handler failed", { command: cmd.command, error: String(err) });
        await this.provider.sendMessage(cmd.channelId, `Error: ${err}`);
      }
    });

    this.provider.onMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        logger.error("Message handler failed", { error: String(err) });
      }
    });

    logger.info("Messaging manager started");
  }

  async stop(): Promise<void> {
    await this.provider.disconnect();
  }

  setMainChannel(channelId: string): void {
    this.mainChannelId = channelId;
  }

  private async handleCommand(cmd: CommandEvent): Promise<void> {
    switch (cmd.command) {
      case "list":
        await this.cmdList(cmd);
        break;
      case "cancel":
        await this.cmdCancel(cmd);
        break;
      case "status":
        await this.cmdStatus(cmd);
        break;
      case "run":
        await this.cmdRun(cmd);
        break;
      case "repos":
        await this.cmdRepos(cmd);
        break;
      case "repo":
        await this.cmdRepo(cmd);
        break;
      case "reindex":
        await this.cmdReindex(cmd);
        break;
      case "tokens":
        await this.cmdTokens(cmd);
        break;
      case "ask":
        await this.cmdAsk(cmd);
        break;
      case "approve":
        await this.cmdApprove(cmd);
        break;
      case "revise":
        await this.cmdRevise(cmd);
        break;
      case "delete-task":
        await this.cmdDeleteTask(cmd);
        break;
      case "clean-done":
        await this.cmdCleanDone(cmd);
        break;
      case "relate":
        await this.cmdRelate(cmd);
        break;
      case "unrelate":
        await this.cmdUnrelate(cmd);
        break;
      case "relationships":
        await this.cmdRelationships(cmd);
        break;
      case "help":
        await this.cmdHelp(cmd);
        break;
      default:
        await this.provider.sendMessage(cmd.channelId, `Unknown command: !${cmd.command}. Type !help for available commands.`);
    }
  }

  private async handleMessage(msg: MessageEvent): Promise<void> {
    // Plain-text messages in the main channel are treated as !ask queries
    if (this.mainChannelId && msg.channelId === this.mainChannelId && !msg.text.startsWith("!")) {
      const askEvent: CommandEvent = {
        command: "ask",
        args: msg.text.split(" "),
        rawText: msg.text,
        channelId: msg.channelId,
        senderId: msg.senderId,
      };
      await this.cmdAsk(askEvent);
      return;
    }

    // Non-command messages in task channels become human input
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(msg.channelId) as { task_id: string } | null;

    if (!channelRow) return; // Not a task channel

    const taskId = channelRow.task_id;

    // Store the message
    this.storeMessage(taskId, "human", msg.senderId, msg.text);

    // Check if there's a pending input request for this task
    const pendingRequest = db.query(
      "SELECT id FROM task_input_requests WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as { id: string } | null;

    if (pendingRequest) {
      const now = new Date().toISOString();
      db.run(
        "UPDATE task_input_requests SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?",
        [msg.text, now, pendingRequest.id]
      );
      await this.provider.sendMessage(msg.channelId, "Answer received. Resuming task...");
    }
  }

  storeMessage(taskId: string, source: string, senderId: string | null, content: string): void {
    const db = getDb();
    db.run(
      "INSERT INTO task_messages (id, task_id, source, sender_id, content) VALUES (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), taskId, source, senderId, content]
    );
  }

  async notifyTaskStatusChange(task: Task, newStatus: TaskStatus): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(task.id) as { channel_id: string } | null;

    if (!channelRow) return;

    // Check for Gitea PR URLs (from task_prs)
    const prs = db.query(
      `SELECT tp.pr_url, r.name as repo_name FROM task_prs tp
       JOIN repos r ON r.id = tp.repo_id
       WHERE tp.task_id = ? AND tp.status = 'open' ORDER BY r.name`
    ).all(task.id) as Array<{ pr_url: string; repo_name: string }>;

    let reviewMsg: string;
    if (prs.length > 1) {
      const prList = prs.map((p) => `  ${p.repo_name}: ${p.pr_url}`).join("\n");
      reviewMsg = `Task ready for review:\n${prList}`;
    } else if (prs.length === 1) {
      reviewMsg = `Task ready for review: ${prs[0].pr_url}`;
    } else {
      reviewMsg = "Task ready for review.";
    }

    const statusMessages: Record<string, string> = {
      scoping: "Determining which repos are affected...",
      planning: "Planning started...",
      scrutinizing: "Scrutinizing plan...",
      replanning: "Revising plan based on scrutiny...",
      finalizing_plan: "Finalizing plan...",
      implementing: "Implementation started...",
      linting: "Running lint checks...",
      fix_linting: "Fixing lint errors...",
      ci_running: "Running CI/tests...",
      ci_fixing: "Fixing CI failures...",
      review: reviewMsg,
      waiting_for_input: "Task is waiting for human input (see question above).",
      accepted: "Task accepted.",
      committed: "Task committed and pushed.",
      failed: "Task failed.",
      cancelled: "Task cancelled.",
    };

    const message = statusMessages[newStatus];
    if (message) {
      await this.provider.sendMessage(channelRow.channel_id, `[${newStatus}] ${message}`);
    }

    if (newStatus === "review" && prs.length > 0) {
      const topic = prs.map((p) => p.pr_url).join(" | ");
      await this.provider.setChannelTopic(channelRow.channel_id, `Review: ${topic}`);
    }
  }

  async notifyAgentOutput(taskId: string, text: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (!channelRow) return;

    // Truncate long output
    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}\n[truncated]` : text;
    await this.provider.sendMessage(channelRow.channel_id, truncated);
  }

  async notifyReviewReady(task: Task): Promise<void> {
    if (this.mainChannelId) {
      const db = getDb();
      const prs = db.query(
        `SELECT tp.pr_url, r.name as repo_name FROM task_prs tp
         JOIN repos r ON r.id = tp.repo_id
         WHERE tp.task_id = ? AND tp.status = 'open' ORDER BY r.name`
      ).all(task.id) as Array<{ pr_url: string; repo_name: string }>;

      let msg: string;
      if (prs.length > 1) {
        const prList = prs.map((p) => `  ${p.repo_name}: ${p.pr_url}`).join("\n");
        msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review:\n${prList}`;
      } else if (prs.length === 1) {
        msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review: ${prs[0].pr_url}`;
      } else {
        msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review.`;
      }
      await this.provider.sendMessage(this.mainChannelId, msg);
    }
  }

  async notifyInputRequest(taskId: string, question: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (channelRow) {
      await this.provider.sendMessage(
        channelRow.channel_id,
        `[Question from agent] ${question}\n\nReply in this channel to answer.`
      );
    }
  }

  async createTaskChannel(task: Task, branchName?: string): Promise<string | null> {
    try {
      const channelId = await this.provider.createTaskChannel(task.id, task.title);

      const db = getDb();
      db.run(
        "INSERT OR REPLACE INTO messaging_channels (task_id, channel_id, provider) VALUES (?, ?, ?)",
        [task.id, channelId, "matrix"]
      );

      const shortId = task.id.slice(0, 8).toLowerCase();
      const channelAlias = `#hoto-task-${shortId}:localhost`;

      // Announce in main channel
      if (this.mainChannelId) {
        const lines = [
          `New task: "${task.title}"`,
          `  ID: ${task.id}`,
          `  Branch: ${branchName ?? "pending"}`,
          `  Channel: ${channelAlias}`,
        ];
        await this.provider.sendMessage(this.mainChannelId, lines.join("\n"));
      }

      // Invite the task creator if known
      const creatorId = this.taskCreators.get(task.id);
      if (creatorId) {
        await this.provider.inviteUser(channelId, creatorId);
        this.taskCreators.delete(task.id);
      }

      // Post summary in the task channel itself
      const lines = [
        `Task: ${task.title}`,
        `ID: ${task.id}`,
        `Branch: ${branchName ?? "pending"}`,
      ];
      await this.provider.sendMessage(channelId, lines.join("\n"));

      return channelId;
    } catch (err) {
      logger.warn("Failed to create task channel", { taskId: task.id, error: String(err) });
      return null;
    }
  }

  async archiveTaskChannel(taskId: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (!channelRow) return;

    try {
      await this.provider.archiveChannel(channelRow.channel_id);
    } catch (err) {
      logger.warn("Failed to archive task channel", { taskId, error: String(err) });
    }
  }

  async kickAndArchiveTaskChannel(taskId: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (!channelRow) return;

    try {
      await this.provider.kickAllMembers(channelRow.channel_id);
    } catch (err) {
      logger.warn("Failed to kick members from task channel", { taskId, error: String(err) });
    }

    try {
      await this.provider.archiveChannel(channelRow.channel_id);
    } catch (err) {
      logger.warn("Failed to archive task channel", { taskId, error: String(err) });
    }
  }

  // Command handlers

  private async cmdRun(cmd: CommandEvent): Promise<void> {
    // Parse: !run <description> [-r repo [-r repo2]]
    const repoNames: string[] = [];
    const descParts: string[] = [];

    for (let i = 0; i < cmd.args.length; i++) {
      if (cmd.args[i] === "-r" && cmd.args[i + 1]) {
        repoNames.push(cmd.args[++i]);
      } else {
        descParts.push(cmd.args[i]);
      }
    }

    const description = descParts.join(" ");
    if (!description) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !run <description> [-r repo [-r repo2]]\nType !help run for details.");
      return;
    }

    const body: Record<string, unknown> = { description, source: "matrix" };
    if (repoNames.length > 1) {
      body.repo_names = repoNames;
    } else if (repoNames.length === 1) {
      body.repo_name = repoNames[0];
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json() as { id: string; title: string };
      this.taskCreators.set(data.id, cmd.senderId);
      await this.provider.sendMessage(cmd.channelId, `Task created: ${data.title} (${data.id.slice(0, 8)})`);
    } else {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdRepo(cmd: CommandEvent): Promise<void> {
    const sub = cmd.args[0];

    if (sub === "remove" || sub === "delete") {
      const name = cmd.args[1];
      if (!name) {
        await this.provider.sendMessage(cmd.channelId, "Usage: !repo remove <name>");
        return;
      }

      const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        await this.provider.sendMessage(cmd.channelId, `Repo archived: ${name}`);
      } else {
        const body = await res.text();
        try {
          const err = JSON.parse(body) as { error: string };
          await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
        } catch {
          await this.provider.sendMessage(cmd.channelId, `Failed: ${body}`);
        }
      }
      return;
    }

    if (sub !== "add" || !cmd.args[1]) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !repo add <git-url> [--name <name>] | !repo remove <name>\nType !help repo for details.");
      return;
    }

    const url = cmd.args[1];
    let name: string | undefined;
    let ciOnHost = false;
    for (let i = 2; i < cmd.args.length; i++) {
      if (cmd.args[i] === "--name" && cmd.args[i + 1]) {
        name = cmd.args[++i];
      } else if (cmd.args[i] === "--allow-ci-on-host") {
        ciOnHost = true;
      }
    }

    await this.provider.sendMessage(cmd.channelId, `Cloning ${url}...`);

    const body: Record<string, string | boolean> = { url };
    if (name) body.name = name;
    if (ciOnHost) body.ci_on_host = true;

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json() as { name: string; language?: string; framework?: string };
      const info = [data.name];
      if (data.language) info.push(`(${data.language})`);
      if (data.framework) info.push(`[${data.framework}]`);
      await this.provider.sendMessage(cmd.channelId, `Repo registered: ${info.join(" ")}. Indexing in background.`);
    } else {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdList(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const tasks = db.query(
      "SELECT id, title, status FROM tasks ORDER BY created_at DESC LIMIT 20"
    ).all() as Array<{ id: string; title: string; status: string }>;

    if (tasks.length === 0) {
      await this.provider.sendMessage(cmd.channelId, "No tasks found.");
      return;
    }

    const lines = tasks.map((t) => `${t.id.slice(0, 8)} [${t.status}] ${t.title}`);
    await this.provider.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdCancel(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;
    const taskId = cmd.args[0] ?? channelRow?.task_id;
    if (!taskId) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !cancel [task-id]");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${taskId}/cancel`, { method: "POST" });
    if (res.ok) {
      await this.provider.sendMessage(cmd.channelId, `Task ${taskId} cancelled.`);
    } else {
      const body = await res.text();
      await this.provider.sendMessage(cmd.channelId, `Failed to cancel: ${body}`);
    }
  }

  private async cmdStatus(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;
    const rawId = cmd.args[0] ?? channelRow?.task_id;
    if (!rawId) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !status [task-id]");
      return;
    }
    // Use exact match when ID came from channel row (full ULID); prefix match when typed by user
    const task = cmd.args[0]
      ? (db.query("SELECT id, title, status, branch_name, created_at, updated_at FROM tasks WHERE id LIKE ?").get(`${rawId}%`) as Record<string, string> | null)
      : (db.query("SELECT id, title, status, branch_name, created_at, updated_at FROM tasks WHERE id = ?").get(rawId) as Record<string, string> | null);

    if (!task) {
      await this.provider.sendMessage(cmd.channelId, "Task not found.");
      return;
    }

    const lines = [
      `Task: ${task.title}`,
      `ID: ${task.id}`,
      `Status: ${task.status}`,
      task.branch_name ? `Branch: ${task.branch_name}` : "",
      `Created: ${task.created_at}`,
      `Updated: ${task.updated_at}`,
    ].filter(Boolean);

    await this.provider.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdRepos(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const repos = db.query("SELECT name, language, framework FROM repos WHERE archived = 0 ORDER BY name").all() as Array<{
      name: string;
      language: string | null;
      framework: string | null;
    }>;

    if (repos.length === 0) {
      await this.provider.sendMessage(cmd.channelId, "No repos registered.");
      return;
    }

    const lines = repos.map((r) => {
      const parts = [r.name];
      if (r.language) parts.push(`(${r.language})`);
      if (r.framework) parts.push(`[${r.framework}]`);
      return parts.join(" ");
    });

    await this.provider.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdReindex(cmd: CommandEvent): Promise<void> {
    let repoName: string | undefined;
    let force = false;

    for (const arg of cmd.args) {
      if (arg === "--force" || arg === "-f") {
        force = true;
      } else if (!repoName) {
        repoName = arg;
      }
    }

    if (!repoName) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !reindex <repo-name> [--force]");
      return;
    }

    const db = getDb();
    const repoRow = db.query("SELECT * FROM repos WHERE name = ? AND archived = 0").get(repoName) as Record<string, unknown> | null;
    if (!repoRow) {
      await this.provider.sendMessage(cmd.channelId, `Repo '${repoName}' not found.`);
      return;
    }

    const label = force ? " (force)" : "";
    await this.provider.sendMessage(cmd.channelId, `Reindexing ${repoName}${label}...`);

    // Run async, report back when done
    const { indexRepo } = await import("../knowledge/indexer");
    const repo = {
      id: repoRow.id as number,
      name: repoRow.name as string,
      path: repoRow.path as string,
      description: repoRow.description as string | null,
      build_cmd: repoRow.build_cmd as string | null,
      test_cmd: repoRow.test_cmd as string | null,
      run_cmd: repoRow.run_cmd as string | null,
      lint_cmd: repoRow.lint_cmd as string | null,
      language: repoRow.language as string | null,
      framework: repoRow.framework as string | null,
      docker_compose_path: repoRow.docker_compose_path as string | null,
      docker_image: repoRow.docker_image as string | null,
      ci_on_host: !!(repoRow.ci_on_host as number),
      metadata: null,
    };

    indexRepo(repo, { force }).then(async (result) => {
      await this.provider.sendMessage(cmd.channelId, `Reindexed ${repoName}: ${result.chunks} chunks, ${result.embeddings} embeddings.`);
    }).catch(async (err) => {
      await this.provider.sendMessage(cmd.channelId, `Reindex failed: ${err}`);
    });
  }

  private async cmdTokens(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.query(
      "SELECT model, input_tokens, output_tokens, cost_usd FROM token_usage_daily WHERE date = ?"
    ).all(today) as Array<{ model: string; input_tokens: number; output_tokens: number; cost_usd: number }>;

    if (rows.length === 0) {
      await this.provider.sendMessage(cmd.channelId, "No token usage today.");
      return;
    }

    const lines = rows.map((r) =>
      `${r.model}: ${r.input_tokens} in / ${r.output_tokens} out ($${r.cost_usd.toFixed(4)})`
    );
    await this.provider.sendMessage(cmd.channelId, `Token usage today:\n${lines.join("\n")}`);
  }

  private async cmdAsk(cmd: CommandEvent): Promise<void> {
    const query = cmd.args.join(" ");
    if (!query) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !ask <question>");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      await this.provider.sendMessage(cmd.channelId, "Ask failed.");
      return;
    }

    const data = await res.json() as { id: string | null; answer?: string; status?: string };

    if (data.answer) {
      await this.provider.sendMessage(cmd.channelId, data.answer);
      return;
    }

    if (data.id) {
      await this.provider.sendMessage(cmd.channelId, "Thinking...");
      // Poll for answer
      const pollAnswer = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollRes = await fetch(`http://127.0.0.1:${config.daemonPort}/knowledge/ask/${data.id}/stream`);
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json() as { status: string; answer?: string; error?: string };
          if (pollData.status === "completed" && pollData.answer) {
            await this.provider.sendMessage(cmd.channelId, pollData.answer);
            return;
          }
          if (pollData.status === "failed") {
            await this.provider.sendMessage(cmd.channelId, `Ask failed: ${pollData.error ?? "unknown error"}`);
            return;
          }
        }
        await this.provider.sendMessage(cmd.channelId, "Ask timed out.");
      };
      pollAnswer();
    }
  }

  private async cmdApprove(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;

    if (!channelRow) {
      await this.provider.sendMessage(cmd.channelId, "This command only works in task channels.");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${channelRow.task_id}/accept`, { method: "POST" });
    if (res.ok) {
      await this.provider.sendMessage(cmd.channelId, "Task approved.");
    } else {
      await this.provider.sendMessage(cmd.channelId, "Failed to approve task.");
    }
  }

  private async cmdRevise(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;

    if (!channelRow) {
      await this.provider.sendMessage(cmd.channelId, "This command only works in task channels.");
      return;
    }

    const feedback = cmd.args.join(" ");
    if (!feedback) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !revise <feedback>");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${channelRow.task_id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });

    if (res.ok) {
      await this.provider.sendMessage(cmd.channelId, "Revision started.");
    } else {
      await this.provider.sendMessage(cmd.channelId, "Failed to start revision.");
    }
  }

  private async cmdDeleteTask(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    let taskId: string | null = null;

    if (cmd.args[0]) {
      // Main channel usage: !delete-task <id-prefix>
      const prefix = cmd.args[0];
      const task = db.query(
        "SELECT id FROM tasks WHERE id LIKE ?"
      ).get(`${prefix}%`) as { id: string } | null;

      if (!task) {
        await this.provider.sendMessage(cmd.channelId, `Task not found: ${prefix}`);
        return;
      }
      taskId = task.id;
    } else {
      // Task channel usage: no argument
      const channelRow = db.query(
        "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
      ).get(cmd.channelId) as { task_id: string } | null;

      if (!channelRow) {
        await this.provider.sendMessage(
          cmd.channelId,
          "Usage: !delete-task <id>  (or run !delete-task from inside a task channel)"
        );
        return;
      }
      taskId = channelRow.task_id;
    }

    // Fetch task title for the announcement before deletion
    const taskRow = db.query("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | null;
    const title = taskRow?.title ?? taskId;

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${taskId}`, {
      method: "DELETE",
    });

    if (res.ok) {
      // Always notify the channel where the command was issued
      await this.provider.sendMessage(cmd.channelId, `Task "${title}" (${taskId}) deleted.`);

      // Also announce in main channel if the command came from a task channel
      if (this.mainChannelId && cmd.channelId !== this.mainChannelId) {
        await this.provider.sendMessage(
          this.mainChannelId,
          `Task "${title}" (${taskId}) deleted.`
        );
      }
    } else {
      const body = await res.text();
      await this.provider.sendMessage(cmd.channelId, `Failed to delete task: ${body}`);
    }
  }

  private async cmdCleanDone(cmd: CommandEvent): Promise<void> {
    await this.provider.sendMessage(cmd.channelId, "Cleaning up finished tasks...");

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/done`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const body = await res.text();
      await this.provider.sendMessage(cmd.channelId, `Failed to clean done tasks: ${body}`);
      return;
    }

    const data = await res.json() as { deleted: string[]; errors: Array<{ id: string; error: string }> };
    const lines: string[] = [];

    if (data.deleted.length === 0) {
      lines.push("No finished tasks to clean up.");
    } else {
      lines.push(`Deleted ${data.deleted.length} finished task(s).`);
    }

    if (data.errors.length > 0) {
      lines.push(`${data.errors.length} error(s):`);
      for (const e of data.errors) {
        lines.push(`  ${e.id.slice(0, 8)}: ${e.error}`);
      }
    }

    await this.provider.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdRelate(cmd: CommandEvent): Promise<void> {
    // !relate <repo-a> <repo-b> <description...>
    if (cmd.args.length < 3) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !relate <repo-a> <repo-b> <description>\nType !help relate for details.");
      return;
    }

    const [repoA, repoB, ...descParts] = cmd.args;
    const description = descParts.join(" ");

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/${repoA}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_repo: repoB,
        relationship: "related",
        description,
      }),
    });

    if (res.ok) {
      await this.provider.sendMessage(cmd.channelId, `Relationship added: ${repoA} <-> ${repoB}: ${description}`);
    } else {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdUnrelate(cmd: CommandEvent): Promise<void> {
    // !unrelate <repo-a> <repo-b> [relationship-type]
    if (cmd.args.length < 2) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !unrelate <repo-a> <repo-b> [relationship-type]\nType !help unrelate for details.");
      return;
    }

    const [repoA, repoB] = cmd.args;
    const relationship = cmd.args[2] ?? "related";

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/${repoA}/relationships`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_repo: repoB,
        relationship,
      }),
    });

    if (res.ok) {
      await this.provider.sendMessage(cmd.channelId, `Relationship removed: ${repoA} <-> ${repoB}`);
    } else {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdRelationships(cmd: CommandEvent): Promise<void> {
    const repoName = cmd.args[0];
    const url = repoName
      ? `http://127.0.0.1:${config.daemonPort}/repos/${repoName}/relationships`
      : `http://127.0.0.1:${config.daemonPort}/repos/relationships`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
      return;
    }

    const data = await res.json() as Array<{
      source_name: string;
      target_name: string;
      relationship: string;
      description: string | null;
    }>;

    if (data.length === 0) {
      await this.provider.sendMessage(cmd.channelId, repoName ? `No relationships for ${repoName}.` : "No repo relationships defined.");
      return;
    }

    const lines = data.map((r) => {
      const desc = r.description ? ` -- ${r.description}` : "";
      return `${r.source_name} -> ${r.target_name} (${r.relationship})${desc}`;
    });
    await this.provider.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdHelp(cmd: CommandEvent): Promise<void> {
    const topic = cmd.args[0];

    if (topic) {
      const detailed = COMMAND_HELP[topic];
      if (detailed) {
        await this.provider.sendMessage(cmd.channelId, detailed);
        return;
      }
      await this.provider.sendMessage(cmd.channelId, `Unknown command: ${topic}. Type !help for a list.`);
      return;
    }

    const help = [
      "Hoto Bot Commands",
      "",
      "General (any channel):",
      "  !list                     List recent tasks (last 20)",
      "  !status [id]              Show task details (status, branch, timestamps)",
      "  !cancel [id]              Cancel a running task and clean up its worktree",
      "  !delete-task <id>         Delete a task and remove all associated data",
      "  !clean-done               Delete all finished tasks (committed, cancelled, failed)",
      "  !run <description>        Submit a new task",
      "  !repos                    List all registered repos with language/framework",
      "  !repo add <url> [--name]  Clone and register a repo from a git URL",
      "  !reindex <repo>           Reindex a repo's knowledge base (docs, code, config)",
      "  !tokens                   Show today's token usage and cost per model",
      "  !ask <question>           Query the knowledge base using AI (or just type in the main channel)",
      "  !relate <a> <b> <desc>   Define a relationship between two repos",
      "  !unrelate <a> <b> [type] Remove a repo relationship",
      "  !relationships [repo]    List repo relationships",
      "  !help [command]           Show this help, or details for a specific command",
      "",
      "In task channels:",
      "  !approve                  Accept the implementation (merge via Gitea)",
      "  !revise <feedback>        Request changes with specific feedback",
      "  !delete-task              Delete this task and close the channel",
      "  (plain messages)          Answer questions from the agent",
    ];
    await this.provider.sendMessage(cmd.channelId, help.join("\n"));
  }
}

let _manager: MessagingManager | null = null;

export function getMessagingManager(): MessagingManager | null {
  return _manager;
}

export function setMessagingManager(manager: MessagingManager): void {
  _manager = manager;
}
