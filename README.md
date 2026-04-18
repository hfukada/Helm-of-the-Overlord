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

**Single-repo:**
```
plan -> scrutinize -> plan-again -> scrutinize -> finalize-plan -> spawn 1 child -> wait
  Child (repo): implement -> lint -> [fix-lint] -> ci -> [fix-ci] -> review -> commit
```

**Multi-repo:** Planning is unified, then each repo gets its own child task running in parallel:
```
Parent: pre-plan -> plan -> scrutinize -> finalize -> spawn children -> wait
  Child A (repo-a): implement -> CI/lint -> PR -> review
  Child B (repo-b): implement -> CI/lint -> PR -> review
```

5. When the pipeline reaches **review**, Hoto opens a Gitea pull request per repo. Approve or reject each PR independently. Rejection triggers a revision cycle on that specific repo only; the task completes when all PRs are merged.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude` must be on your PATH)
- Git
- [Gitea](https://gitea.io) instance with an admin token (optional -- required for PR review workflow)
- [Ollama](https://ollama.ai) (optional):
  - `nomic-embed-text` — local vector embeddings (falls back to keyword search without it)
  - `llama3.2` (or the model set in `OLLAMA_MODEL`) — alternative agent backend when `HOTO_PROVIDER=ollama`
  - `llama3.2:3b` (or `HOTO_INTENT_MODEL`) — intent classification for plain-text chat messages
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
      projects.ts            Projects REST endpoints
      version.ts             Version endpoint
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
  agent/                     Claude Code CLI agent wrapper
    claude-code-cli.ts       ClaudeCodeCliAgent: spawns and manages Claude CLI subprocesses
    tools.ts                 Tool definitions passed to the agent
    persistence.ts           Agent run persistence helpers
    types.ts                 Agent-related TypeScript types
    ollama.ts                OllamaAgent: in-process tool execution via Ollama API
  projects/                  Projects feature: breaks long-horizon tasks into sequential milestones
    planner.ts               Generates milestone plans for projects
    runner.ts                Executes project milestones sequentially
  orchestrator/
    blueprint.ts             Pipeline state machine
    task-runner.ts           Runs parent task pipeline (plan -> children or implement)
    child-task-runner.ts     Runs child tasks (implement -> CI -> review per repo)
    plan-splitter.ts         Extracts per-repo plan excerpts from [repo-name] tags
    plan-parser.ts           Parses structured plan output from the plan node
    timeline.ts              Timeline tracking for task phases
    resume-on-startup.ts     Resumes in-progress tasks after daemon restart
    resume-utils.ts          Helpers for determining resumable task state
    subprocess-registry.ts   Tracks active Claude subprocesses
    subprocess.ts            Spawns Claude subagents (host or sandboxed)
    context-builder.ts       Assembles prompts from knowledge base
    errors.ts                Orchestrator error types
    nodes/
      agentic/               plan, implement, fix-lint, fix-ci (Claude-driven)
      deterministic/         lint, git-ops, docker-compose (shell commands)
  prompts/                   Markdown prompt templates per pipeline stage
  treesitter/                Tree-sitter code analysis for repo maps and symbol extraction
    repo-map.ts              Generates repo maps from source files
    symbols.ts               Extracts symbols (functions, classes, etc.) from source files
    references.ts            Tracks cross-file symbol references
    parser.ts                Tree-sitter parser setup and language detection
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
| `OLLAMA_MODEL` | `llama3.2` | Ollama model used by OllamaAgent for task execution (`HOTO_PROVIDER=ollama`) |
| `HOTO_PROVIDER` | `claude` | Agent backend: `claude` (Claude CLI subagents) or `ollama` (local Ollama) |

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
  !project "<description>" [-r repo]    Start a new project (long-horizon, sequential milestones)
  !project list                         List all projects
  !project status <id>                  Show project detail and milestone progress
  !project delete <id>                  Delete a project
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

## Projects

Projects break long-horizon tasks into a sequence of milestones, each executed as its own task with its own PR. Use projects when a feature is too large for a single agent run.

- Start a project with `!project "description"` (chat) or `POST /projects` (API)
- Hoto generates a milestone plan using Claude and the knowledge base
- Each milestone runs through the full task pipeline (plan -> implement -> CI/lint -> PR -> review)
- Milestones execute sequentially; a failed milestone pauses the project
- Progress is tracked per-milestone; projects can be resumed after the underlying issue is fixed

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

## API Reference

The daemon exposes a REST API on `http://127.0.0.1:7777` (configurable via `HOTO_HOST`/`HOTO_PORT`). All request and response bodies are JSON. Timestamps are ISO 8601 strings. Error responses use `{ "error": "<message>" }` with an appropriate HTTP status code.

### Health & Version

**`GET /health`**
- Response: `{ "status": "ok", "pid": number }`

**`GET /version`**
- Response: `{ "version": string, "commit": string | null, "datetime": string | null }`

---

### Tasks

**`GET /tasks`**
- Response: Array of task objects with fields `id, title, status, repo_id, branch_name, source, created_at, updated_at`.

**`POST /tasks`**
- Request body:
  ```json
  {
    "description": "string (required)",
    "title": "string (optional)",
    "repo_name": "string (optional, target a single repo by name)",
    "repo_names": ["string (optional, target multiple repos by name)"],
    "source": "string (optional, e.g. 'cli', 'matrix', 'discord')",
    "source_sender_id": "string (optional)",
    "source_provider": "string (optional)"
  }
  ```
- Response (201): `{ "id": string, "title": string, "status": "pending", "repo_count": number }`

**`GET /tasks/:id`**
- Response: Full task object including:
  - `blueprint_state`: object | null
  - `agent_runs`: array of agent run records
  - `repos`: array of `{ id, name, language, framework, role }`
  - `prs`: array of `{ id, repo_id, pr_number, pr_url, status, repo_name }`
  - `children`: array of child task summaries

**`DELETE /tasks/:id`**
- Response: `{ "id": string, "deleted": true }`

**`DELETE /tasks/done`**
- Query params: `status` (optional, filter by status)
- Response: `{ "deleted": string[], "errors": [{ "id": string, "error": string }] }`

**`POST /tasks/:id/cancel`**
- Response: `{ "id": string, "status": "cancelled" }`

**`GET /tasks/:id/diff`**
- Response: `{ "diff": string | null }`

**`GET /tasks/:id/diff/summary`**
- Response: `{ "summary": [{ "file": string, "insertions": number, "deletions": number }] | null }`

---

### Child Tasks

**`GET /tasks/:taskId/children`**
- Response: Array of child task objects with fields `id, status, repo_name, language, pr_number, pr_url, ci_passed, lint_passed, created_at, updated_at`.

**`POST /tasks/:taskId/children/:childId/retry`**
- Response: `{ "id": string, "status": "pending" }`

**`POST /tasks/:taskId/children/:childId/cancel`**
- Response: `{ "id": string, "status": "cancelled" }`

---

### Review & Commit

**`POST /tasks/:id/accept`**
- Marks task as accepted (merges PR via Gitea if configured).
- Response: `{ "id": string, "status": "accepted" }`

**`POST /tasks/:id/commit`**
- Commits and pushes changes for a task.
- Request body:
  ```json
  {
    "message": "string (required)",
    "branch_name": "string (optional)"
  }
  ```
- Response: `{ "id": string, "status": "committed", "branch": string }`

---

### Agent Runs

**`GET /tasks/:taskId/agents`**
- Response: Array of agent run records with fields `id, node_name, agent_type, status, prompt, output, token_input, token_output, cost_usd, model, started_at, finished_at, error`.

---

### Comments

**`GET /tasks/:taskId/comments`**
- Response: Array of diff comment objects ordered by `file_path, line_number`.

**`POST /tasks/:taskId/comments`**
- Request body:
  ```json
  {
    "file_path": "string (required)",
    "line_number": "number (optional)",
    "side": "string (optional, default 'right')",
    "body": "string (required)"
  }
  ```
- Response (201): `{ "id": string, "task_id": string, "file_path": string, "line_number": number | null, "side": string, "body": string, "resolved": boolean }`

**`PATCH /comments/:commentId`**
- Request body: `{ "body": "string (optional)", "resolved": "boolean (optional)" }`
- Response: Full updated comment object.

**`DELETE /comments/:commentId`**
- Response: `{ "deleted": true }`

---

### Repositories

**`GET /repos`**
- Response: Array of repo objects (non-archived) with all fields.

**`POST /repos`**
- Request body:
  ```json
  {
    "url": "string (git clone URL, required if path not provided)",
    "path": "string (local path, required if url not provided)",
    "name": "string (optional, derived from path/url if omitted)",
    "description": "string (optional)",
    "language": "string (optional)",
    "framework": "string (optional)",
    "build_cmd": "string (optional)",
    "test_cmd": "string (optional)",
    "run_cmd": "string (optional)",
    "lint_cmd": "string (optional)",
    "ci_on_host": "boolean (optional, allow CI to run on host without Docker)"
  }
  ```
- Response (201): `{ "id": number, "name": string, "path": string, "language": string | null, "framework": string | null }`

**`GET /repos/:name`**
- Response: Full repo object.

**`PATCH /repos/:name`**
- Request body: Any subset of `{ description, language, framework, build_cmd, test_cmd, run_cmd, lint_cmd, ci_on_host }`.
- Response: Updated repo object.

**`DELETE /repos/:name`**
- Response: `{ "deleted": string }` (the repo name)

---

### Repository Secrets

**`GET /repos/:repoName/secrets`**
- Response: Array of container secret objects ordered by `key`.

**`POST /repos/:repoName/secrets`**
- Request body:
  ```json
  {
    "secret_type": "env_var | auth_file (required)",
    "key": "string (required)",
    "value_source": "host_env | host_file (required)",
    "host_path": "string (required for auth_file type)",
    "container_path": "string (optional)",
    "description": "string (optional)"
  }
  ```
- Response (201): `{ "id": number, "key": string }`

**`PATCH /repos/:repoName/secrets/:secretId`**
- Request body: `{ "verified": "boolean (optional)", "description": "string (optional)" }`
- Response: `{ "updated": number }`

**`DELETE /repos/:repoName/secrets/:secretId`**
- Response: `{ "removed": number }`

---

### Repository Relationships

**`GET /repos/:repoName/relationships`**
- Response: Array of relationship objects where the repo is source or target, with fields `source_repo_id, target_repo_id, relationship, description, source_name, target_name`.

**`POST /repos/:repoName/relationships`**
- Request body:
  ```json
  {
    "target_repo": "string (required)",
    "relationship": "string (required, e.g. 'depends-on', 'shared-types')",
    "description": "string (optional)"
  }
  ```
- Response (201): `{ "source_repo": string, "target_repo": string, "relationship": string, "description": string | null }`

**`DELETE /repos/relationships/:id`**
- Response: `{ "removed": true }`

---

### Token Usage

**`GET /tokens`**
- Response:
  ```json
  {
    "daily": [{ "date": string, "model": string, "input_tokens": number, "output_tokens": number, "cost_usd": number }],
    "totals": { "total_input": number, "total_output": number, "total_cost": number }
  }
  ```

---

### Knowledge Base

**`GET /knowledge/search`**
- Query params: `q` (required, search query), `repo` (optional, filter by repo name), `limit` (optional, default 10)
- Response: `{ "results": [{ "repo_name": string, "source_file": string, "chunk_type": string, "content": string, "score": number }], "count": number }`

---

### Projects

**`GET /projects`**
- Response: Array of project objects (last 100, ordered by `created_at` DESC) with fields `id, title, description, status, repo_names, architecture_notes, carry_over_notes, created_at, updated_at`.

**`POST /projects`**
- Request body:
  ```json
  {
    "description": "string (required)",
    "repo_names": ["string (optional, target specific repos by name)"],
    "architecture_notes": "string (optional, planner context)"
  }
  ```
- Response (201): `{ "id": string, "title": string, "status": "planning" }`

**`GET /projects/:id`**
- Response: Full project object including `tasks` array with milestone task summaries.

**`PATCH /projects/:id`**
- Request body: Any subset of `{ "title": string, "description": string, "status": string, "architecture_notes": string, "carry_over_notes": string }`.
- Response: Updated project object.

**`DELETE /projects/:id`**
- Response: `{ "deleted": true }`

## License

MIT
