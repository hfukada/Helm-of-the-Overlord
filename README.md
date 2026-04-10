<p align="center">
  <img src="helm.png" width="128" alt="Helm of the Overlord" />
</p>

# Hoto (Helm of the Overlord)

Named after the Dota 2 item [Helm of the Overlord](https://dota2.fandom.com/wiki/Helm_of_the_Overlord) -- which grants the ability to take control of units in the game.

Multi-repo, multi-agent one-shot task manager. Describe a task in plain text, and Hoto spins up Claude subagents to plan, implement, lint, test, and open a Gitea pull request for review -- all in an isolated git worktree.

## How it works

1. Register one or more git repos with `hoto repos add`
2. Start the daemon with `hoto daemon start`
3. Submit a task: `hoto run "add a retry mechanism to the HTTP client"`
4. Hoto creates a worktree branch and runs a pipeline:

```
pre-plan (multi-repo only) -> plan -> scrutinize -> plan-again -> scrutinize -> finalize-plan -> implement -> lint -> [fix-lint] -> ci -> [fix-ci] -> review -> commit
```

5. When the pipeline reaches **review**, Hoto opens a Gitea pull request. Approve or reject the PR in Gitea. Rejection triggers a revision cycle; approval marks the task committed.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude` must be on your PATH)
- Git
- [Gitea](https://gitea.io) instance with an admin token (optional -- required for PR review workflow)
- [Ollama](https://ollama.ai) with `nomic-embed-text` (optional -- for local vector embeddings)
- [ChromaDB](https://www.trychroma.com) (optional -- vector search backend; falls back to keyword search)

## Install

```sh
git clone <repo-url> && cd helm-of-the-overlord
bun install
bun link   # makes `hoto` available globally
```

## Quick start

```sh
# Start the daemon (runs on port 7777)
hoto daemon start

# Register a repo
hoto repos add /path/to/your/project

# Submit a task
hoto run "refactor the database connection pool to use async initialization"

# Watch progress
hoto status

# Open the Gitea PR
hoto open
```

## CLI reference

```
hoto run "task description"        Submit a task
hoto run "task description" -r name  Target a specific repo
hoto run -f task.txt               Submit task from file
hoto status                        List tasks
hoto status <id>                   Task detail and Gitea PR link
hoto cancel <id>                   Cancel a running task
hoto delete <id>                   Delete a task and clean up all data
hoto ask "question" [-r repo]      Query the knowledge base
hoto repos                         List registered repos
hoto repos add /path/to/repo      Register and index a repo
hoto repos remove <name>           Unregister a repo
hoto repos reindex [name]          Re-index repo knowledge base
hoto tokens                        Token usage summary
hoto open [task-id]                Open Gitea PR in browser
hoto daemon start|stop|status     Daemon management
```

## Web UI

The daemon serves static assets at `http://127.0.0.1:7777/app/` when built UI assets are present. The UI is provided by the separate `hoto-ui` repository (Svelte 5 + Vite + Tailwind CSS 4) and must be built and placed in the daemon's static asset path before the UI is available.

## Architecture

```
src/
  index.ts                   Entry point (routes to CLI or daemon)
  daemon/
    server.ts                Hono HTTP server + static file serving
    routes/                  REST endpoints (tasks, agents, repos, tokens, comments, commits, knowledge, secrets)
  cli/
    index.ts                 Command router
    commands/                One file per command
  gitea/                     Gitea REST client, PR creation, review polling
  knowledge/
    db.ts                    SQLite connection
    schema.ts                Migrations
    embeddings.ts            Ollama vector embeddings
    indexer.ts               Repo content indexer
    repo-parser.ts           Auto-detect language/framework/commands
    search.ts                Hybrid vector + keyword search
  mcp/                       MCP server (stdio JSON-RPC) exposing knowledge base to agents
  messaging/                 Chat bot integration (Matrix, Discord)
    matrix/client.ts         Matrix (Synapse) provider
    discord/client.ts        Discord provider
  orchestrator/
    blueprint.ts             Pipeline state machine
    task-runner.ts           Runs blueprint nodes in sequence
    subprocess.ts            Spawns Claude subagents
    context-builder.ts       Assembles prompts from knowledge base
    nodes/
      agentic/               plan, implement, fix-lint, fix-ci (Claude-driven)
      deterministic/         lint, git-ops, docker-compose (shell commands)
  prompts/                   Markdown prompt templates per pipeline stage
  workspace/
    manager.ts               Workspace directory management
    git.ts                   Worktree, diff, commit operations
    docker.ts                Docker Compose support
    docker-exec.ts           Container execution with secret mounting
    secret-discovery.ts      Pattern-based credential auto-discovery
  shared/
    types.ts                 TypeScript types
    config.ts                Configuration
    logger.ts                Structured logging
```

## Configuration

All configuration is via environment variables. The daemon reads these at startup.

| Variable | Default | Description |
|---|---|---|
| `HOTO_WORKSPACE` | `~/.hoto-workspace` | Root directory for worktrees, DB, and logs |
| `HOTO_HOST` | `127.0.0.1` | Daemon bind address |
| `HOTO_PORT` | `7777` | Daemon HTTP port |
| `HOTO_MODEL` | `claude-sonnet-4-6` | Claude model used for agent runs |
| `CHROMA_URL` | `http://127.0.0.1:8033` | ChromaDB URL for vector search (optional) |
| `MATRIX_HOMESERVER_URL` | — | Matrix homeserver URL for the bot (optional) |
| `MATRIX_BOT_USER` | `@hoto:localhost` | Matrix bot user ID (optional) |
| `MATRIX_BOT_PASSWORD` | — | Matrix bot password (optional) |
| `MATRIX_BOT_TOKEN` | — | Matrix bot access token (optional, alternative to password) |
| `DISCORD_BOT_TOKEN` | — | Discord bot token (optional) |
| `DISCORD_GUILD_ID` | — | Discord server (guild) ID (optional) |
| `GITEA_URL` | — | Gitea instance URL (optional) |
| `GITEA_ADMIN_TOKEN` | — | Gitea admin token for PR creation (optional) |
| `GITEA_BOT_USER` | `hoto-bot` | Gitea bot username |
| `GITEA_BOT_PASSWORD` | `hoto-bot-default` | Gitea bot password |
| `GITEA_ORG` | `hoto` | Gitea organization for repos |
| `GITEA_POLL_INTERVAL_MS` | `15000` | Interval for polling PR review status (ms) |
| `HOTO_SANDBOX_CLAUDE` | `false` | Run Claude subprocesses in sandboxed Docker containers |
| `HOTO_MCP_HTTP_PORT` | `7778` | Port for MCP HTTP/SSE server (sandbox mode) |
| `HOTO_DATA_VOLUME` | — | Docker named volume for workspace (containerized deployment) |
| `HOTO_HOSTNAME` | `localhost` | Hostname for external URLs (Gitea PR links) |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server URL for intent classification |
| `HOTO_INTENT_MODEL` | `llama3.2:3b` | Ollama model for classifying chat messages |

## Chat integration

Hoto supports Matrix and Discord as chat providers. Both can be enabled simultaneously -- commands and notifications work identically across both.

### Matrix

Set `MATRIX_HOMESERVER_URL`, `MATRIX_BOT_USER`, and `MATRIX_BOT_PASSWORD` (or `MATRIX_BOT_TOKEN`). The bot auto-registers on first run if the homeserver allows open registration.

### Discord

Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`. Create a bot at [discord.com/developers](https://discord.com/developers/applications) with the **Message Content** privileged intent enabled. Invite it to your server with `bot` + `applications.commands` scopes.

### Commands

Both providers respond to the same `!` commands in their main channel:

```
General (any channel):
  !run <description> [-r repo]          Submit a task
  !list                                 List recent tasks
  !status [id]                          Show task details
  !cancel [id]                          Cancel a running task
  !delete-task <id>                     Delete a task and all data
  !clean-done                           Delete all finished tasks
  !repos                                List registered repos
  !repo add <url> [--name] [--allow-ci-on-host]   Clone and register a repo
  !repo remove <name>                   Unregister a repo
  !reindex <repo> [--force]             Reindex repo knowledge base
  !tokens                               Show token usage and cost
  !ask <question>                       Query the knowledge base
  !relate <a> <b> <desc>                Define a repo relationship
  !unrelate <a> <b> [type]              Remove a repo relationship
  !relationships [repo]                 List repo relationships
  !help [command]                       Show help

In task channels:
  !approve                              Accept the implementation (merge via Gitea)
  !revise <feedback>                    Request changes with specific feedback
  !delete-task                          Delete this task and close the channel
  (plain messages)                      Answer questions from the agent
```

Plain-text messages in the main channel are classified by intent (via Ollama) and routed to either `!run` or `!ask` automatically.

## MCP server

The knowledge base is accessible to Claude agents via MCP (Model Context Protocol):

- **stdio transport** (default): Spawned per-agent by the orchestrator. No configuration needed.
- **HTTP/SSE transport** (sandbox mode): Started on `HOTO_MCP_HTTP_PORT` (default 7778) when `HOTO_SANDBOX_CLAUDE=true`. Sandboxed Claude containers connect via `http://host.docker.internal:<port>/sse`.

Available tool: `search_knowledge` -- semantic and keyword search across indexed repo content. Agents use native `Read`/`Glob`/`Grep` for direct file access.

## Tech stack

- **Runtime**: Bun (bun:sqlite, Bun.spawn, Bun.serve)
- **HTTP**: Hono
- **Database**: SQLite (WAL mode)
- **AI**: Claude CLI subagents with streaming JSON output (sandboxed in Docker)
- **Intent classification**: Ollama + llama3.2:3b (local, no API cost)
- **Vector search**: ChromaDB (falls back to keyword search)
- **Chat**: Matrix (Synapse) + Discord
- **Code review**: Gitea (self-hosted)
- **Web UI**: Svelte 5 + Vite + Tailwind CSS 4 (separate `hoto-ui` repo)
- **Containers**: Docker (sandbox execution, CI/lint isolation)

## License

MIT
