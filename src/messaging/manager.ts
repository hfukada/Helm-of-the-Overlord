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
    "!status <id>",
    "Show details for a task. You can use just the first few characters of the ID.",
    "Shows: title, full ID, status, branch name, created/updated timestamps.",
    "Example: !status 01JA3B",
  ].join("\n"),
  cancel: [
    "!cancel <id>",
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
    "Clone a git repo and register it. Auto-detects language, framework, and commands.",
    "Indexes the repo into the knowledge base after cloning.",
    "Examples:",
    "  !repo add https://github.com/org/project.git",
    "  !repo add git@github.com:org/project.git --name my-project",
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
  help: [
    "!help [command]",
    "Show the command list, or detailed help for a specific command.",
    "Example: !help run",
  ].join("\n"),
};

export class MessagingManager {
  private provider: MessagingProvider;
  private mainChannelId: string | null = null;

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
      case "help":
        await this.cmdHelp(cmd);
        break;
      default:
        await this.provider.sendMessage(cmd.channelId, `Unknown command: !${cmd.command}. Type !help for available commands.`);
    }
  }

  private async handleMessage(msg: MessageEvent): Promise<void> {
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

    // Check for Gitea PR URL
    const prRow = db.query("SELECT gitea_pr_url FROM tasks WHERE id = ?").get(task.id) as { gitea_pr_url: string | null } | null;
    const reviewUrl = prRow?.gitea_pr_url ?? `http://${config.daemonHost}:${config.daemonPort}/tasks/${task.id}`;

    const statusMessages: Record<string, string> = {
      planning: "Planning started...",
      implementing: "Implementation started...",
      linting: "Running lint checks...",
      fix_linting: "Fixing lint errors...",
      ci_running: "Running CI/tests...",
      ci_fixing: "Fixing CI failures...",
      review: `Task ready for review: ${reviewUrl}`,
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

    if (newStatus === "review") {
      await this.provider.setChannelTopic(
        channelRow.channel_id,
        `Review: ${reviewUrl}`
      );
    }
  }

  async notifyAgentOutput(taskId: string, text: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (!channelRow) return;

    // Truncate long output
    const truncated = text.length > 2000 ? text.slice(0, 2000) + "\n[truncated]" : text;
    await this.provider.sendMessage(channelRow.channel_id, truncated);
  }

  async notifyReviewReady(task: Task): Promise<void> {
    if (this.mainChannelId) {
      const db = getDb();
      const prRow = db.query("SELECT gitea_pr_url FROM tasks WHERE id = ?").get(task.id) as { gitea_pr_url: string | null } | null;
      const url = prRow?.gitea_pr_url ?? `http://${config.daemonHost}:${config.daemonPort}/tasks/${task.id}`;
      await this.provider.sendMessage(
        this.mainChannelId,
        `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review: ${url}`
      );
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

  async createTaskChannel(task: Task): Promise<string | null> {
    try {
      const channelId = await this.provider.createTaskChannel(task.id, task.title);

      const db = getDb();
      db.run(
        "INSERT OR REPLACE INTO messaging_channels (task_id, channel_id, provider) VALUES (?, ?, ?)",
        [task.id, channelId, "matrix"]
      );

      // Announce in main channel
      if (this.mainChannelId) {
        await this.provider.sendMessage(
          this.mainChannelId,
          `New task: "${task.title}" (${task.id.slice(0, 8)}) -- see task channel`
        );
      }

      return channelId;
    } catch (err) {
      logger.warn("Failed to create task channel", { taskId: task.id, error: String(err) });
      return null;
    }
  }

  // Command handlers

  private async cmdRun(cmd: CommandEvent): Promise<void> {
    // Parse: !run <description> [-r repo]
    let repoName: string | undefined;
    const descParts: string[] = [];

    for (let i = 0; i < cmd.args.length; i++) {
      if (cmd.args[i] === "-r" && cmd.args[i + 1]) {
        repoName = cmd.args[++i];
      } else {
        descParts.push(cmd.args[i]);
      }
    }

    const description = descParts.join(" ");
    if (!description) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !run <description> [-r repo]\nType !help run for details.");
      return;
    }

    const body: Record<string, string> = { description, source: "matrix" };
    if (repoName) body.repo_name = repoName;

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json() as { id: string; title: string };
      await this.provider.sendMessage(cmd.channelId, `Task created: ${data.title} (${data.id.slice(0, 8)})`);
    } else {
      const err = await res.json() as { error: string };
      await this.provider.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdRepo(cmd: CommandEvent): Promise<void> {
    const sub = cmd.args[0];
    if (sub !== "add" || !cmd.args[1]) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !repo add <git-url> [--name <name>]\nType !help repo for details.");
      return;
    }

    const url = cmd.args[1];
    let name: string | undefined;
    for (let i = 2; i < cmd.args.length; i++) {
      if (cmd.args[i] === "--name" && cmd.args[i + 1]) {
        name = cmd.args[++i];
      }
    }

    await this.provider.sendMessage(cmd.channelId, `Cloning ${url}...`);

    const body: Record<string, string> = { url };
    if (name) body.name = name;

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
    const taskId = cmd.args[0];
    if (!taskId) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !cancel <task-id>");
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
    const taskId = cmd.args[0];
    if (!taskId) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !status <task-id>");
      return;
    }

    const db = getDb();
    const task = db.query(
      "SELECT id, title, status, branch_name, created_at, updated_at FROM tasks WHERE id LIKE ?"
    ).get(`${taskId}%`) as Record<string, string> | null;

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
    const repos = db.query("SELECT name, language, framework FROM repos ORDER BY name").all() as Array<{
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
    const repoName = cmd.args[0];
    if (!repoName) {
      await this.provider.sendMessage(cmd.channelId, "Usage: !reindex <repo-name>");
      return;
    }

    await this.provider.sendMessage(cmd.channelId, `Reindexing ${repoName}...`);
    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/knowledge/repos/${repoName}/reindex`, { method: "POST" });
    if (res.ok) {
      const data = await res.json() as { chunks_indexed: number; embeddings_generated: number };
      await this.provider.sendMessage(cmd.channelId, `Reindexed: ${data.chunks_indexed} chunks, ${data.embeddings_generated} embeddings.`);
    } else {
      await this.provider.sendMessage(cmd.channelId, "Reindex failed.");
    }
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
      "  !status <id>              Show task details (status, branch, timestamps)",
      "  !cancel <id>              Cancel a running task and clean up its worktree",
      "  !run <description>        Submit a new task",
      "  !repos                    List all registered repos with language/framework",
      "  !repo add <url> [--name]  Clone and register a repo from a git URL",
      "  !reindex <repo>           Reindex a repo's knowledge base (docs, code, config)",
      "  !tokens                   Show today's token usage and cost per model",
      "  !ask <question>           Query the knowledge base using AI",
      "  !help [command]           Show this help, or details for a specific command",
      "",
      "In task channels:",
      "  !approve                  Accept the implementation (merge via Gitea)",
      "  !revise <feedback>        Request changes with specific feedback",
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
