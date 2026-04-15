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
  projects: [
    "!projects",
    "List all projects with their ID (first 8 chars), status, and title.",
    "Example: !projects",
  ].join("\n"),
  project: [
    "!project <title> [-r repo [-r repo2]] [-d description text]",
    "Create a new project from a messaging platform.",
    "Options:",
    "  -r <repo>   Target repo (can be repeated for multi-repo)",
    "  -d <text>   Description (optional; all tokens after -d until next flag)",
    "Examples:",
    "  !project New auth system -r my-api",
    "  !project Refactor login -r my-api -d Remove legacy session handling",
  ].join("\n"),
  "repo": [
    "!repo add <git-url> [--name <name>]",
    "!repo remove <name>",
    "Add or remove a repo.",
    "  add: Clone a git repo and register it. Auto-detects language, framework, and commands.",
    "  remove: Hard-delete a repo and its embeddings (blocked if active tasks).",
    "Examples:",
    "  !repo add https://github.com/org/project.git",
    "  !repo add git@github.com:org/project.git --name my-project",
    "  !repo remove my-project",
  ].join("\n"),
  "newrepo": [
    "!newrepo <name> <seed prompt>",
    "Initialize a new empty git repo named <name> and immediately submit a seeding task.",
    "The seed prompt is passed as the task description to bootstrap the new project.",
    "Example: !newrepo my-service Create a minimal HTTP server in TypeScript with Bun and Hono",
  ].join("\n"),
  "delete-repo": [
    "!delete-repo <name>",
    "Same as !repo remove. Hard-delete a repo and its embeddings (blocked if active tasks).",
    "Example: !delete-repo my-project",
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
  "purge": [
    "!purge <status>",
    "Delete all tasks with a given status (e.g. failed, cancelled, implementing).",
    "Calls cleanupTask for any live (non-terminal) status, stopping running orchestrator processes before deleting.",
    "Example: !purge failed",
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
  private providers = new Map<string, MessagingProvider>();
  private mainChannelIds = new Map<string, string>(); // providerName -> channelId
  private taskCreators = new Map<string, { senderId: string; providerName: string }>();

  registerProvider(provider: MessagingProvider): void {
    this.providers.set(provider.providerName, provider);

    provider.onCommand(async (cmd) => {
      try {
        await this.handleCommand(cmd);
      } catch (err) {
        logger.error("Command handler failed", { command: cmd.command, error: String(err) });
        const p = this.providers.get(cmd.providerName);
        if (p) await p.sendMessage(cmd.channelId, `Error: ${err}`);
      }
    });

    provider.onMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        logger.error("Message handler failed", { error: String(err) });
      }
    });
  }

  async stop(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.disconnect();
    }
  }

  setMainChannel(providerName: string, channelId: string): void {
    this.mainChannelIds.set(providerName, channelId);
  }

  private getProviderForTask(taskId: string): MessagingProvider | null {
    const db = getDb();
    const row = db.query(
      "SELECT provider FROM messaging_channels WHERE task_id = ? LIMIT 1"
    ).get(taskId) as { provider: string } | null;
    if (!row) return null;
    return this.providers.get(row.provider) ?? null;
  }

  /** Get all (provider, channelId) pairs for a task. */
  private getTaskChannels(taskId: string): Array<{ provider: MessagingProvider; channelId: string }> {
    const db = getDb();
    const rows = db.query(
      "SELECT provider, channel_id FROM messaging_channels WHERE task_id = ?"
    ).all(taskId) as Array<{ provider: string; channel_id: string }>;

    const result: Array<{ provider: MessagingProvider; channelId: string }> = [];
    for (const row of rows) {
      const p = this.providers.get(row.provider);
      if (p) result.push({ provider: p, channelId: row.channel_id });
    }
    return result;
  }

  /** Send a message to all channels for a task. */
  private async sendToTaskChannels(taskId: string, message: string): Promise<void> {
    for (const { provider, channelId } of this.getTaskChannels(taskId)) {
      try {
        await provider.sendMessage(channelId, message);
      } catch (err) {
        logger.warn("Failed to send to task channel", {
          taskId, provider: provider.providerName, error: String(err),
        });
      }
    }
  }

  private getSenderProvider(event: { providerName: string }): MessagingProvider | null {
    return this.providers.get(event.providerName) ?? null;
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
      case "projects":
        await this.cmdProjects(cmd);
        break;
      case "project":
        await this.cmdProject(cmd);
        break;
      case "repo":
        await this.cmdRepo(cmd);
        break;
      case "newrepo":
        await this.cmdNewRepo(cmd);
        break;
      case "delete-repo":
        await this.cmdDeleteRepo(cmd);
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
      case "purge":
        await this.cmdPurge(cmd);
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
      case "health":
        await this.cmdHealth(cmd);
        break;
      default:
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Unknown command: !${cmd.command}. Type !help for available commands.`);
    }
  }

  private async guessIntent(text: string): Promise<"run" | "ask" | "cancel"> {
    const prompt =
      "Classify the user message as exactly one intent.\n\n" +
      "run = the user wants to change code, fix something, add a feature, update something, or do any task that modifies files\n" +
      "ask = the user is asking a question and does NOT want code changes\n" +
      "cancel = the user wants to stop or cancel something\n\n" +
      "If the message mentions fixing, adding, changing, updating, or implementing anything, classify as: run\n\n" +
      `Message: ${text}\n\n` +
      "Intent (one word):";

    const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
    const ollamaModel = process.env.HOTO_INTENT_MODEL ?? "llama3.2:3b";

    try {
      const res = await fetch(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false, options: { temperature: 0 } }),
      });

      if (!res.ok) {
        logger.warn("Ollama intent classification failed, defaulting to ask", { status: res.status });
        return "ask";
      }

      const data = await res.json() as { response?: string };
      const reply = (data.response ?? "").trim().toLowerCase();
      const match = reply.match(/\b(run|ask|cancel)\b/);
      const intent = match ? match[1] as "run" | "ask" | "cancel" : "ask";
      logger.info("Intent classified", { text: text.slice(0, 80), reply, intent });
      return intent;
    } catch (err) {
      logger.error("guessIntent failed, defaulting to ask", { error: String(err) });
      return "ask";
    }
  }

  private async handleMessage(msg: MessageEvent): Promise<void> {
    // Plain-text messages in the main channel use intent guessing
    const senderMainChannelId = this.mainChannelIds.get(msg.providerName) ?? null;
    if (senderMainChannelId && msg.channelId === senderMainChannelId && !msg.text.startsWith("!")) {
      const intent = await this.guessIntent(msg.text);
      if (intent === "run") {
        await this.cmdRun({ ...msg, command: "run", args: msg.text.split(" "), rawText: msg.text });
      } else if (intent === "cancel") {
        await this.getSenderProvider(msg)?.sendMessage(msg.channelId, "To cancel a task, use: !cancel <task-id>");
      } else {
        await this.cmdAsk({ ...msg, command: "ask", args: msg.text.split(" "), rawText: msg.text });
      }
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
      await this.getSenderProvider(msg)?.sendMessage(msg.channelId, "Answer received. Resuming task...");
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
    const channels = this.getTaskChannels(task.id);
    if (channels.length === 0) return;

    const db = getDb();

    // Check for Gitea PR URLs (from task_prs)
    const prs = db.query(
      `SELECT tp.pr_url, r.name as repo_name FROM task_prs tp
       JOIN repos r ON r.id = tp.repo_id
       WHERE tp.task_id = ? AND tp.status = 'open' ORDER BY r.name`
    ).all(task.id) as Array<{ pr_url: string; repo_name: string }>;

    let reviewMsg: string;
    if (prs.length > 1) {
      const prList = prs.map((pr) => `  ${pr.repo_name}: ${pr.pr_url}`).join("\n");
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
    for (const { provider, channelId } of channels) {
      try {
        if (message) {
          await provider.sendMessage(channelId, `[${newStatus}] ${message}`);
        }
        if (newStatus === "review" && prs.length > 0) {
          const topic = prs.map((pr) => pr.pr_url).join(" | ");
          await provider.setChannelTopic(channelId, `Review: ${topic}`);
        }
      } catch (err) {
        logger.warn("Failed to notify task status change", {
          taskId: task.id, provider: provider.providerName, error: String(err),
        });
      }
    }

    if (newStatus === "review") {
      await this.notifyReviewReady(task);
    }
  }

  async notifyAgentOutput(taskId: string, text: string): Promise<void> {
    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}\n[truncated]` : text;
    await this.sendToTaskChannels(taskId, truncated);
  }

  async notifyReviewReady(task: Task): Promise<void> {
    const db = getDb();
    const prs = db.query(
      `SELECT tp.pr_url, r.name as repo_name FROM task_prs tp
       JOIN repos r ON r.id = tp.repo_id
       WHERE tp.task_id = ? AND tp.status = 'open' ORDER BY r.name`
    ).all(task.id) as Array<{ pr_url: string; repo_name: string }>;

    let msg: string;
    if (prs.length > 1) {
      const prList = prs.map((pr) => `  ${pr.repo_name}: ${pr.pr_url}`).join("\n");
      msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review:\n${prList}`;
    } else if (prs.length === 1) {
      msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review: ${prs[0].pr_url}`;
    } else {
      msg = `Task "${task.title}" (${task.id.slice(0, 8)}) is ready for review.`;
    }

    // Announce in all main channels
    for (const [providerName, p] of this.providers) {
      const mainChannelId = this.mainChannelIds.get(providerName);
      if (mainChannelId) {
        try {
          await p.sendMessage(mainChannelId, msg);
        } catch (err) {
          logger.warn("notifyReviewReady failed", { provider: providerName, err });
        }
      }
    }
  }

  async notifyPRCreated(taskId: string, repoName: string, prUrl: string, taskTitle: string): Promise<void> {
    const msg = `PR created for "${taskTitle}" [${repoName}]: ${prUrl}`;
    for (const [providerName, p] of this.providers) {
      const mainChannelId = this.mainChannelIds.get(providerName);
      if (mainChannelId) {
        try {
          await p.sendMessage(mainChannelId, msg);
        } catch (err) {
          logger.warn('notifyPRCreated failed', { provider: providerName, err });
        }
      }
    }
  }

  async notifyIndexingComplete(
    repoName: string,
    chunks: number,
    embeddings: number,
    skipProviderChannel?: { providerName: string; channelId: string }
  ): Promise<void> {
    const msg = `Indexed ${repoName}: ${chunks} chunks, ${embeddings} embeddings.`;
    for (const [providerName, p] of this.providers) {
      const mainChannelId = this.mainChannelIds.get(providerName);
      if (!mainChannelId) continue;
      if (
        skipProviderChannel &&
        skipProviderChannel.providerName === providerName &&
        skipProviderChannel.channelId === mainChannelId
      ) continue;
      try {
        await p.sendMessage(mainChannelId, msg);
      } catch (err) {
        logger.warn("Failed to send indexing notification", { provider: providerName, error: String(err) });
      }
    }
  }

  async notifyInputRequest(taskId: string, question: string): Promise<void> {
    await this.sendToTaskChannels(
      taskId,
      `[Question from agent] ${question}\n\nReply in this channel to answer.`
    );
  }

  async createTaskChannel(task: Task, branchName?: string): Promise<string | null> {
    // Try in-memory map first, then fall back to DB (handles race condition)
    let creator = this.taskCreators.get(task.id) ?? null;
    if (!creator) {
      const db = getDb();
      const row = db.query(
        "SELECT source_sender_id, source_provider FROM tasks WHERE id = ?"
      ).get(task.id) as { source_sender_id: string | null; source_provider: string | null } | null;
      if (row?.source_sender_id && row?.source_provider) {
        creator = { senderId: row.source_sender_id, providerName: row.source_provider };
      }
    }
    let firstChannelId: string | null = null;

    const summary = [
      `Task: ${task.title}`,
      `ID: ${task.id}`,
      `Branch: ${branchName ?? "pending"}`,
    ].join("\n");

    // Create a task channel on every active provider
    for (const [providerName, p] of this.providers) {
      try {
        const channelId = await p.createTaskChannel(task.id, task.title);

        const db = getDb();
        db.run(
          "INSERT OR REPLACE INTO messaging_channels (task_id, channel_id, provider) VALUES (?, ?, ?)",
          [task.id, channelId, providerName]
        );

        if (!firstChannelId) firstChannelId = channelId;

        // Announce in main channel with per-provider channel link for the originating platform
        const mainChannelId = this.mainChannelIds.get(providerName);
        if (mainChannelId) {
          const lines = [
            `New task: "${task.title}"`,
            `  ID: ${task.id}`,
            `  Branch: ${branchName ?? "pending"}`,
          ];
          if (creator?.providerName === providerName) {
            if (providerName === "discord") {
              lines.push(`  Channel: <#${channelId}>`);
            } else {
              lines.push(`  Channel: ${channelId}`);
            }
          }
          await p.sendMessage(mainChannelId, lines.join("\n"));
        }

        // Invite the task creator if they used this provider
        if (creator?.providerName === providerName && creator.senderId) {
          await p.inviteUser(channelId, creator.senderId);
        }

        // Post summary in the task channel
        await p.sendMessage(channelId, summary);
      } catch (err) {
        logger.warn("Failed to create task channel on provider", {
          taskId: task.id, provider: providerName, error: String(err),
        });
      }
    }

    this.taskCreators.delete(task.id);
    return firstChannelId;
  }

  async archiveTaskChannel(taskId: string): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT channel_id FROM messaging_channels WHERE task_id = ?"
    ).get(taskId) as { channel_id: string } | null;

    if (!channelRow) return;

    const p = this.getProviderForTask(taskId);
    if (p) {
      try {
        await p.archiveChannel(channelRow.channel_id);
      } catch (err) {
        logger.warn("Failed to archive task channel", { taskId, error: String(err) });
      }
    }
  }

  async kickAndArchiveTaskChannel(taskId: string): Promise<void> {
    for (const { provider, channelId } of this.getTaskChannels(taskId)) {
      await this.kickAndArchiveChannelId(provider, channelId);
    }
  }

  private async kickAndArchiveChannelId(
    provider: MessagingProvider,
    channelId: string
  ): Promise<void> {
    try { await provider.kickAllMembers(channelId); } catch (err) {
      logger.warn("Failed to kick members", { provider: provider.providerName, channelId, error: String(err) });
    }
    try { await provider.archiveChannel(channelId); } catch (err) {
      logger.warn("Failed to archive channel", { provider: provider.providerName, channelId, error: String(err) });
    }
  }

  private async deleteOrphanedChannels(): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    for (const [providerName, provider] of this.providers) {
      let liveIds: string[];
      try {
        liveIds = await provider.listTaskChannelIds();
      } catch (err) {
        logger.warn("Failed to list task channel IDs", { providerName, error: String(err) });
        errors++;
        continue;
      }
      const rows = getDb()
        .prepare("SELECT channel_id FROM messaging_channels WHERE provider = ?")
        .all(providerName) as { channel_id: string }[];
      const knownIds = new Set(rows.map((r) => r.channel_id));
      for (const channelId of liveIds) {
        if (!knownIds.has(channelId)) {
          try {
            await this.kickAndArchiveChannelId(provider, channelId);
            deleted++;
            logger.info("Deleted orphaned channel", { providerName, channelId });
          } catch (err) {
            logger.warn("Failed to delete orphaned channel", { providerName, channelId, error: String(err) });
            errors++;
          }
        }
      }
    }
    return { deleted, errors };
  }

  private async runOrphanCleanup(): Promise<string[]> {
    const { deleted, errors } = await this.deleteOrphanedChannels();
    const lines: string[] = [];
    if (deleted === 0 && errors === 0) {
      lines.push("No orphaned channels.");
    } else {
      if (deleted > 0) lines.push(`Deleted ${deleted} orphaned channel(s).`);
      if (errors > 0) lines.push(`${errors} error(s) during orphan cleanup.`);
    }
    return lines;
  }

  // Command handlers

  private async createTask(
    cmd: CommandEvent,
    body: Record<string, unknown>,
    successLabel: string
  ): Promise<void> {
    body.source_sender_id = cmd.senderId;
    body.source_provider = cmd.providerName;

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json() as { id: string; title: string };
      this.taskCreators.set(data.id, { senderId: cmd.senderId, providerName: cmd.providerName });
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `${successLabel}: ${data.id.slice(0, 8)}`);
    } else {
      const err = await res.json() as { error: string };
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !run <description> [-r repo [-r repo2]]\nType !help run for details.");
      return;
    }

    const body: Record<string, unknown> = { description, source: cmd.providerName };
    if (repoNames.length > 1) {
      body.repo_names = repoNames;
    } else if (repoNames.length === 1) {
      body.repo_name = repoNames[0];
    }

    await this.createTask(cmd, body, "Task queued");
  }

  private async cmdProject(cmd: CommandEvent): Promise<void> {
    // Parse: !project <title> [-r repo [-r repo2]] [-d description text]
    // Tokens before the first flag form the title.
    // -r <repo> can appear multiple times.
    // -d <text> consumes all remaining tokens until the next recognized flag.
    const repoNames: string[] = [];
    const titleParts: string[] = [];
    const descParts: string[] = [];

    let i = 0;
    // Collect title tokens until first flag
    while (i < cmd.args.length && cmd.args[i] !== "-r" && cmd.args[i] !== "-d") {
      titleParts.push(cmd.args[i++]);
    }
    // Parse remaining flags
    while (i < cmd.args.length) {
      if (cmd.args[i] === "-r" && cmd.args[i + 1]) {
        repoNames.push(cmd.args[++i]);
        i++;
      } else if (cmd.args[i] === "-d") {
        i++;
        // Consume tokens until next recognized flag
        while (i < cmd.args.length && !(cmd.args[i] === "-r" || cmd.args[i] === "-d")) {
          descParts.push(cmd.args[i++]);
        }
      } else {
        i++;
      }
    }

    const title = titleParts.join(" ").trim();
    if (!title) {
      await this.getSenderProvider(cmd)?.sendMessage(
        cmd.channelId,
        "Usage: !project <title> [-r repo [-r repo2]] [-d description text]\nType !help project for details."
      );
      return;
    }

    // description defaults to "" when -d is omitted (prevents route throwing on undefined.slice())
    const description = descParts.join(" ");

    const body: Record<string, unknown> = { title, description, source: "messaging" };
    if (repoNames.length > 1) {
      body.repo_names = repoNames;
    } else if (repoNames.length === 1) {
      body.repo_name = repoNames[0];
    }

    await this.createTask(cmd, body, "Project queued");
  }

  private async cmdRepo(cmd: CommandEvent): Promise<void> {
    const sub = cmd.args[0];

    if (sub === "remove" || sub === "delete") {
      const name = cmd.args[1];
      if (!name) {
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !repo remove <name>");
        return;
      }

      const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Repo deleted: ${name}`);
      } else if (res.status === 409) {
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Cannot delete repo: active tasks exist`);
      } else {
        const body = await res.text();
        try {
          const err = JSON.parse(body) as { error: string };
          await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
        } catch {
          await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${body}`);
        }
      }
      return;
    }

    if (sub !== "add" || !cmd.args[1]) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !repo add <git-url> [--name <name>] | !repo remove <name>\nType !help repo for details.");
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

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Cloning ${url}...`);

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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Repo registered: ${info.join(" ")}. Indexing in background.`);
    } else {
      const err = await res.json() as { error: string };
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdNewRepo(cmd: CommandEvent): Promise<void> {
    const name = cmd.args[0];
    const seedPrompt = cmd.args.slice(1).join(" ").trim();

    if (!name || !seedPrompt) {
      await this.getSenderProvider(cmd)?.sendMessage(
        cmd.channelId,
        "Usage: !newrepo <name> <seed prompt>\nExample: !newrepo my-service Create a minimal HTTP server in TypeScript with Bun and Hono"
      );
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      await this.getSenderProvider(cmd)?.sendMessage(
        cmd.channelId,
        `Failed to initialize repo: ${err.error ?? res.statusText}`
      );
      return;
    }

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Repo initialized: ${name}`);

    await this.createTask(
      cmd,
      { description: seedPrompt, repo_name: name, source: cmd.providerName },
      "Seed task queued"
    );
  }

  private async cmdDeleteRepo(cmd: CommandEvent): Promise<void> {
    const name = cmd.args[0];
    if (!name) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !delete-repo <name>");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/repos/${name}`, {
      method: "DELETE",
    });

    if (res.ok) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Repo deleted: ${name}`);
    } else if (res.status === 409) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Cannot delete repo: active tasks exist`);
    } else {
      const body = await res.text();
      try {
        const err = JSON.parse(body) as { error: string };
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
      } catch {
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${body}`);
      }
    }
  }

  private async cmdList(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const tasks = db.query(
      "SELECT id, title, status FROM tasks ORDER BY created_at DESC LIMIT 20"
    ).all() as Array<{ id: string; title: string; status: string }>;

    if (tasks.length === 0) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "No tasks found.");
      return;
    }

    const lines = tasks.map((t) => `${t.id.slice(0, 8)} [${t.status}] ${t.title}`);
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdCancel(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;
    const taskId = cmd.args[0] ?? channelRow?.task_id;
    if (!taskId) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !cancel [task-id]");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${taskId}/cancel`, { method: "POST" });
    if (res.ok) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Task ${taskId} cancelled.`);
    } else {
      const body = await res.text();
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed to cancel: ${body}`);
    }
  }

  private async cmdStatus(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;
    const rawId = cmd.args[0] ?? channelRow?.task_id;
    if (!rawId) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !status [task-id]");
      return;
    }
    // Use exact match when ID came from channel row (full ULID); prefix match when typed by user
    const task = cmd.args[0]
      ? (db.query("SELECT id, title, status, branch_name, created_at, updated_at FROM tasks WHERE id LIKE ?").get(`${rawId}%`) as Record<string, string> | null)
      : (db.query("SELECT id, title, status, branch_name, created_at, updated_at FROM tasks WHERE id = ?").get(rawId) as Record<string, string> | null);

    if (!task) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Task not found.");
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

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdRepos(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const repos = db.query("SELECT name, language, framework FROM repos WHERE archived = 0 ORDER BY name").all() as Array<{
      name: string;
      language: string | null;
      framework: string | null;
    }>;

    if (repos.length === 0) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "No repos registered.");
      return;
    }

    const lines = repos.map((r) => {
      const parts = [r.name];
      if (r.language) parts.push(`(${r.language})`);
      if (r.framework) parts.push(`[${r.framework}]`);
      return parts.join(" ");
    });

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdProjects(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const rows = db.query(
      "SELECT id, title, status FROM projects ORDER BY created_at DESC, id DESC LIMIT 100"
    ).all() as Array<{ id: string; title: string; status: string }>;

    if (rows.length === 0) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "No projects found.");
      return;
    }

    const lines = ["Projects:", ...rows.map((r) => `${r.id.slice(0, 8)}  [${r.status}]  ${r.title}`)];
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !reindex <repo-name> [--force]");
      return;
    }

    const db = getDb();
    const repoRow = db.query("SELECT * FROM repos WHERE name = ? AND archived = 0").get(repoName) as Record<string, unknown> | null;
    if (!repoRow) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Repo '${repoName}' not found.`);
      return;
    }

    const label = force ? " (force)" : "";
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Reindexing ${repoName}${label}...`);

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

    const senderProvider = this.getSenderProvider(cmd);
    indexRepo(repo, { force }).then(async (result) => {
      await senderProvider?.sendMessage(cmd.channelId, `Reindexed ${repoName}: ${result.chunks} chunks, ${result.embeddings} embeddings.`);
      try {
        await this.notifyIndexingComplete(repoName, result.chunks, result.embeddings, {
          providerName: cmd.providerName,
          channelId: cmd.channelId,
        });
      } catch (err) {
        logger.warn("Failed to send indexing notification from cmdReindex", { error: String(err) });
      }
    }).catch(async (err) => {
      await senderProvider?.sendMessage(cmd.channelId, `Reindex failed: ${err}`);
    });
  }

  private async cmdTokens(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.query(
      "SELECT model, input_tokens, output_tokens, cost_usd FROM token_usage_daily WHERE date = ?"
    ).all(today) as Array<{ model: string; input_tokens: number; output_tokens: number; cost_usd: number }>;

    if (rows.length === 0) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "No token usage today.");
      return;
    }

    const lines = rows.map((r) =>
      `${r.model}: ${r.input_tokens} in / ${r.output_tokens} out ($${r.cost_usd.toFixed(4)})`
    );
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Token usage today:\n${lines.join("\n")}`);
  }

  private async cmdAsk(cmd: CommandEvent): Promise<void> {
    const query = cmd.args.join(" ");
    if (!query) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !ask <question>");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/knowledge/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Ask failed.");
      return;
    }

    const data = await res.json() as { id: string | null; answer?: string; status?: string };

    if (data.answer) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, data.answer);
      return;
    }

    if (data.id) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Thinking...");
      // Poll for answer
      const senderProvider = this.getSenderProvider(cmd);
      const pollAnswer = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollRes = await fetch(`http://127.0.0.1:${config.daemonPort}/knowledge/ask/${data.id}/stream`);
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json() as { status: string; answer?: string; error?: string };
          if (pollData.status === "completed" && pollData.answer) {
            await senderProvider?.sendMessage(cmd.channelId, pollData.answer);
            return;
          }
          if (pollData.status === "failed") {
            await senderProvider?.sendMessage(cmd.channelId, `Ask failed: ${pollData.error ?? "unknown error"}`);
            return;
          }
        }
        await senderProvider?.sendMessage(cmd.channelId, "Ask timed out.");
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "This command only works in task channels.");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${channelRow.task_id}/accept`, { method: "POST" });
    if (res.ok) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Task approved.");
    } else {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Failed to approve task.");
    }
  }

  private async cmdRevise(cmd: CommandEvent): Promise<void> {
    const db = getDb();
    const channelRow = db.query(
      "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
    ).get(cmd.channelId) as { task_id: string } | null;

    if (!channelRow) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "This command only works in task channels.");
      return;
    }

    const feedback = cmd.args.join(" ");
    if (!feedback) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !revise <feedback>");
      return;
    }

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/${channelRow.task_id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });

    if (res.ok) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Revision started.");
    } else {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Failed to start revision.");
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
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Task not found: ${prefix}`);
        return;
      }
      taskId = task.id;
    } else {
      // Task channel usage: no argument
      const channelRow = db.query(
        "SELECT task_id FROM messaging_channels WHERE channel_id = ?"
      ).get(cmd.channelId) as { task_id: string } | null;

      if (!channelRow) {
        await this.getSenderProvider(cmd)?.sendMessage(
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Task "${title}" (${taskId}) deleted.`);

      // Also announce in main channel if the command came from a task channel
      const senderMainChannelId = this.mainChannelIds.get(cmd.providerName) ?? null;
      if (senderMainChannelId && cmd.channelId !== senderMainChannelId) {
        await this.getSenderProvider(cmd)?.sendMessage(
          senderMainChannelId,
          `Task "${title}" (${taskId}) deleted.`
        );
      }
    } else {
      const body = await res.text();
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed to delete task: ${body}`);
    }
  }

  private async cmdCleanDone(cmd: CommandEvent): Promise<void> {
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Cleaning up finished tasks...");

    const res = await fetch(`http://127.0.0.1:${config.daemonPort}/tasks/done`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const body = await res.text();
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed to clean done tasks: ${body}`);
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

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdPurge(cmd: CommandEvent): Promise<void> {
    if (!cmd.args[0]) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !purge <status>");
      return;
    }
    const status = cmd.args[0];
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Purging tasks with status '${status}'...`);
    const res = await fetch(
      `http://127.0.0.1:${config.daemonPort}/tasks/done?status=${encodeURIComponent(status)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const body = await res.text();
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Error: ${body}`);
      return;
    }
    const { deleted, errors } = await res.json() as { deleted: string[]; errors: Array<{ id: string; error: string }> };
    const lines = [`Purged ${deleted.length} task(s) with status '${status}'.`];
    for (const e of errors) lines.push(`Error: ${e.id.slice(0, 8)}: ${e.error}`);
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdRelate(cmd: CommandEvent): Promise<void> {
    // !relate <repo-a> <repo-b> <description...>
    if (cmd.args.length < 3) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !relate <repo-a> <repo-b> <description>\nType !help relate for details.");
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Relationship added: ${repoA} <-> ${repoB}: ${description}`);
    } else {
      const err = await res.json() as { error: string };
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
    }
  }

  private async cmdUnrelate(cmd: CommandEvent): Promise<void> {
    // !unrelate <repo-a> <repo-b> [relationship-type]
    if (cmd.args.length < 2) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, "Usage: !unrelate <repo-a> <repo-b> [relationship-type]\nType !help unrelate for details.");
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Relationship removed: ${repoA} <-> ${repoB}`);
    } else {
      const err = await res.json() as { error: string };
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
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
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Failed: ${err.error}`);
      return;
    }

    const data = await res.json() as Array<{
      source_name: string;
      target_name: string;
      relationship: string;
      description: string | null;
    }>;

    if (data.length === 0) {
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, repoName ? `No relationships for ${repoName}.` : "No repo relationships defined.");
      return;
    }

    const lines = data.map((r) => {
      const desc = r.description ? ` -- ${r.description}` : "";
      return `${r.source_name} -> ${r.target_name} (${r.relationship})${desc}`;
    });
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, lines.join("\n"));
  }

  private async cmdHealth(cmd: CommandEvent): Promise<void> {
    const results: string[] = ["Service Health Check", ""];

    // Gitea
    try {
      const giteaUrl = config.giteaUrl;
      if (giteaUrl) {
        const res = await fetch(`${giteaUrl}/api/v1/version`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json() as { version?: string };
          results.push(`Gitea: OK (v${data.version ?? "?"})`);
        } else {
          results.push(`Gitea: ERROR (HTTP ${res.status})`);
        }
      } else {
        results.push("Gitea: not configured");
      }
    } catch (err) {
      results.push(`Gitea: UNREACHABLE (${String(err).slice(0, 80)})`);
    }

    // ChromaDB
    try {
      const res = await fetch(`${config.chromaUrl}/api/v2/heartbeat`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        results.push("ChromaDB: OK");
      } else {
        results.push(`ChromaDB: ERROR (HTTP ${res.status})`);
      }
    } catch (err) {
      results.push(`ChromaDB: UNREACHABLE (${String(err).slice(0, 80)})`);
    }

    // Ollama
    try {
      const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
      const res = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> };
        const models = data.models?.map((m) => m.name).join(", ") ?? "none";
        results.push(`Ollama: OK (models: ${models})`);
      } else {
        results.push(`Ollama: ERROR (HTTP ${res.status})`);
      }
    } catch (err) {
      results.push(`Ollama: UNREACHABLE (${String(err).slice(0, 80)})`);
    }

    // Matrix
    const matrixProvider = this.providers.get("matrix");
    if (matrixProvider) {
      results.push(`Matrix: connected (main: ${this.mainChannelIds.get("matrix") ?? "none"})`);
    } else if (config.matrixHomeserverUrl) {
      results.push("Matrix: configured but not connected");
    } else {
      results.push("Matrix: not configured");
    }

    // Discord
    const discordProvider = this.providers.get("discord");
    if (discordProvider) {
      results.push(`Discord: connected (main: ${this.mainChannelIds.get("discord") ?? "none"})`);
    } else if (config.discordBotToken) {
      results.push("Discord: configured but not connected");
    } else {
      results.push("Discord: not configured");
    }

    // MCP HTTP (sandbox mode)
    if (config.sandboxClaude) {
      try {
        const res = await fetch(`http://127.0.0.1:${config.mcpHttpPort}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          results.push(`MCP HTTP: OK (port ${config.mcpHttpPort})`);
        } else {
          results.push(`MCP HTTP: ERROR (HTTP ${res.status})`);
        }
      } catch (err) {
        results.push(`MCP HTTP: UNREACHABLE (${String(err).slice(0, 80)})`);
      }
    } else {
      results.push("MCP HTTP: disabled (sandbox not enabled)");
    }

    // Sandbox image
    if (config.sandboxClaude) {
      try {
        const proc = Bun.spawnSync(["docker", "image", "inspect", "hoto-sandbox:latest"], { stdout: "pipe", stderr: "pipe" });
        results.push(proc.exitCode === 0 ? "Sandbox image: OK" : "Sandbox image: NOT FOUND");
      } catch {
        results.push("Sandbox image: docker not available");
      }
    }

    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, results.join("\n"));
  }

  private async cmdHelp(cmd: CommandEvent): Promise<void> {
    const topic = cmd.args[0];

    if (topic) {
      const detailed = COMMAND_HELP[topic];
      if (detailed) {
        await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, detailed);
        return;
      }
      await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, `Unknown command: ${topic}. Type !help for a list.`);
      return;
    }

    const help = [
      "Hoto Bot Commands",
      "",
      "General (any channel):",
      "  !run <description> [-r repo]   Submit a new task",
      "  !project <title> [-r repo] [-d desc]  Create a named project",
      "  !list                          List recent tasks (last 20)",
      "  !status [id]                   Show task details",
      "  !cancel [id]                   Cancel a running task",
      "  !delete-task <id>              Delete a task and all data",
      "  !clean-done                    Delete all finished tasks",
      "  !purge <status>                Delete all tasks with a given status",
      "  !repos                         List registered repos",
      "  !projects                      List all projects",
      "  !repo add <url> [--name] [--allow-ci-on-host]",
      "                                 Clone and register a repo",
      "  !repo remove <name>            Unregister a repo",
      "  !newrepo <name> <seed>         Init a new repo and seed it with a task",
      "  !reindex <repo> [--force]      Reindex repo knowledge base",
      "  !tokens                        Show token usage and cost",
      "  !ask <question>                Query the knowledge base",
      "  !relate <a> <b> <desc>         Define a repo relationship",
      "  !unrelate <a> <b> [type]       Remove a repo relationship",
      "  !relationships [repo]          List repo relationships",
      "  !health                        Check service connectivity",
      "  !help [command]                Show this help",
      "",
      "In task channels:",
      "  !approve                       Accept and merge via Gitea",
      "  !revise <feedback>             Request changes with feedback",
      "  !delete-task                   Delete task and close channel",
      "  (plain messages)               Answer questions from the agent",
      "",
      "Plain text in the main channel is auto-classified as a task or question.",
    ];
    await this.getSenderProvider(cmd)?.sendMessage(cmd.channelId, help.join("\n"));
  }
}

let _manager: MessagingManager | null = null;

export function getMessagingManager(): MessagingManager | null {
  return _manager;
}

export function setMessagingManager(manager: MessagingManager): void {
  _manager = manager;
}
