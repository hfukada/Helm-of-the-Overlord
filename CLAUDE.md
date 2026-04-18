# Hoto (Helm of the Overlord)

Multi-repo, multi-agent one-shot task manager. Built with Bun + Hono + SQLite.

## Conventions

- Runtime: Bun (use `bun run`, `bun test`, never `npm` or `npx`)
- No emojis in code or output
- Structured logging via src/shared/logger.ts (signature: `logger.info(msg, data?)` -- NOT pino-style `logger.info({data}, msg)`)
- ULIDs for task and agent run IDs
- All paths should use the workspace directory (~/.hoto-workspace by default, /data in Docker)
- Daemon runs on port 7777 by default
- API dates are returned in ISO 8601 format (use `fixDates` from `src/daemon/dates.ts`)

## Project Structure

- `src/index.ts` - Entry point: routes to CLI or daemon based on args
- `src/daemon/` - Hono HTTP server, routes, WebSocket
- `src/daemon/dates.ts` - ISO 8601 date helpers for API responses
- `src/daemon/routes/projects.ts` - Projects REST endpoints
- `src/daemon/routes/version.ts` - Version endpoint
- `src/daemon/routes/comments.ts` - Diff comments REST endpoints
- `src/cli/` - CLI arg parsing and commands
- `src/gitea/` - Gitea REST client, PR creation, review polling
- `src/knowledge/` - SQLite DB, schema, embeddings, search
- `src/mcp/` - MCP server (stdio + HTTP/SSE transports) for knowledge base access
- `src/messaging/` - Chat bot integration (Matrix, Discord)
- `src/agent/` - Claude Code CLI agent wrapper
- `src/agent/claude-code-cli.ts` - ClaudeCodeCliAgent: spawns and manages Claude CLI subprocesses
- `src/agent/tools.ts` - Tool definitions passed to the agent
- `src/agent/persistence.ts` - Agent run persistence helpers
- `src/agent/types.ts` - Agent-related TypeScript types
- `src/agent/loop-detection.ts` - Detects and breaks infinite loops in agent runs
- `src/agent/ollama.ts` - OllamaAgent implementation (local model alternative to Claude)
- `src/projects/` - Projects feature: breaks long-horizon tasks into sequential milestones
- `src/projects/planner.ts` - Generates milestone plans for projects
- `src/projects/runner.ts` - Executes project milestones sequentially
- `src/orchestrator/` - Blueprint engine, subprocess management, agent nodes
- `src/orchestrator/plan-parser.ts` - Parses structured plan output from the plan node
- `src/orchestrator/timeline.ts` - Timeline tracking for task phases
- `src/orchestrator/resume-on-startup.ts` - Resumes in-progress tasks after daemon restart
- `src/orchestrator/resume-utils.ts` - Helpers for determining resumable task state
- `src/orchestrator/subprocess-registry.ts` - Tracks active Claude subprocesses
- `src/orchestrator/errors.ts` - Orchestrator error types
- `src/orchestrator/nodes/agentic/` - Agent nodes (plan, implement, scrutinize, fix-ci, fix-lint, review-feedback)
- `src/orchestrator/nodes/agentic/types.ts` - SandboxOptions type
- `src/prompts/` - Markdown prompt templates per pipeline stage
- `src/treesitter/` - Tree-sitter code analysis for repo maps and symbol extraction
- `src/treesitter/repo-map.ts` - Generates repo maps from source files
- `src/treesitter/symbols.ts` - Extracts symbols (functions, classes, etc.) from source files
- `src/treesitter/references.ts` - Tracks cross-file symbol references
- `src/treesitter/parser.ts` - Tree-sitter parser setup and language detection
- `src/workspace/` - Workspace directory, git operations, Docker container management
- `src/workspace/docker-exec.ts` - Sandbox container lifecycle, CI container setup
- `src/shared/` - Types, config, logger

## Key Commands

### Daemon
- `bun run src/index.ts daemon start` - Start daemon
- `bun run src/index.ts daemon stop` - Stop daemon
- `bun run src/index.ts daemon status` - Show daemon status

### Tasks
- `bun run src/index.ts run "task description"` - Submit task
- `bun run src/index.ts status` - List tasks
- `bun run src/index.ts cancel <id>` - Cancel a task
- `bun run src/index.ts delete <id>` - Delete a task
- `bun run src/index.ts ask <id> "question"` - Ask a running task a question
- `bun run src/index.ts open <id>` - Open task in browser

### Repos
- `bun run src/index.ts repos` - List registered repos

### Tokens
- `bun run src/index.ts tokens` - Show token usage stats

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOTO_WORKSPACE` | `~/.hoto-workspace` | Workspace directory for repos, DB, and task data |
| `HOTO_DAEMON_PORT` | `7777` | Port the daemon listens on |
| `HOTO_SANDBOX_CLAUDE` | `false` | Run Claude subprocesses inside Docker sandbox containers |
| `HOTO_DATA_VOLUME` | _(none)_ | Docker named volume for workspace (e.g. `helm-of-the-overlord_hoto-data`) |
| `HOTO_MCP_HTTP_PORT` | `7778` | Port for MCP HTTP/SSE server |
| `GITEA_URL` | _(required)_ | Base URL of Gitea instance (e.g. `http://localhost:3777`) |
| `GITEA_TOKEN` | _(required)_ | Gitea API token |
| `MATRIX_HOMESERVER` | _(optional)_ | Matrix homeserver URL for chat bot integration |
| `MATRIX_TOKEN` | _(optional)_ | Matrix access token |
| `DISCORD_TOKEN` | _(optional)_ | Discord bot token |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL (used by OllamaAgent) |
| `MINIMAX_API_KEY` | _(none)_ | MiniMax API key (required when `HOTO_PROVIDER=minimax`) |
| `MINIMAX_GROUP_ID` | _(none)_ | MiniMax Group ID (required when `HOTO_PROVIDER=minimax`) |
| `MINIMAX_BASE_URL` | `https://api.minimax.chat/v1` | MiniMax API base URL |

## Testing

Tests run in a Docker container to isolate them from the local workspace and DB.

```
bun run test                # Run all tests in a container (default)
bun run test:local          # Run tests locally (uses bun test directly -- avoid, leaks test data into ~/.hoto-workspace)
bun run test:e2e            # Run the e2e hello-world integration test directly (no container)
bun run typecheck           # Type-check without emitting
bun run lint                # Lint with Biome
```

- `bun run test` builds `Dockerfile.test` via `docker-compose.test.yml` and runs `bun test` inside a container with a tmpfs workspace at `/tmp/hoto-test`.
- Tests that require the `claude` CLI (integration tests calling the actual Claude API) are auto-skipped when `claude` is not installed in the container.
- Tests that use the DB set `process.env.HOTO_WORKSPACE` to a `/tmp/` path before any imports, giving each test file its own isolated SQLite DB.
- **Never run `bun test` directly** on a machine with a live daemon -- test data (fake repos, tasks) will leak into the production DB.

## Blueprint Flow

### Single-repo tasks

```
pre-plan (skipped) -> plan -> scrutinize -> plan-again -> scrutinize -> finalize-plan -> spawn 1 child -> wait
  |
  +-- Child (repo): implement -> lint -> [fix-lint] -> ci -> [fix-ci] -> review -> commit
```

### Multi-repo tasks (child task architecture)

```
Parent: pre-plan -> plan -> scrutinize -> plan-again -> scrutinize -> finalize-plan -> spawn children -> wait
  |
  +-- Child A (repo-a): implement -> lint -> [fix-lint] -> ci -> [fix-ci] -> review -> commit
  +-- Child B (repo-b): implement -> lint -> [fix-lint] -> ci -> [fix-ci] -> review -> commit
  (children run in parallel, independent failure)
```

After finalize-plan, the parent extracts per-repo plan excerpts using `[repo-name]` tags from the plan steps, creates a `child_tasks` row per repo, and launches them in parallel via `Promise.allSettled`.

### Review rejection triage (both single and child tasks)

```
review -> understand_review -> [small] review_small_feedback -> implement (skip scrutiny)
                            -> [large] review_large_feedback -> scrutinize -> ... -> implement
```

### Node details

- **Pre-plan**: Runs only when multiple repos are registered. Determines which repos need changes.
- **Plan**: Produces an implementation plan (maxTurns: 15).
- **Scrutinize**: Reviews the plan against a checklist (maxTurns: 10).
- **Plan-again/Finalize-plan**: Revises and finalizes the plan (maxTurns: 10).
- **Implement**: Follows the plan mechanically. Turns estimated dynamically from plan complexity (15-50).
- **Lint/CI**: Per-repo with fix loops (max 2 lint, max 2 CI rounds). Auto-installs dependencies in containers.
- **Review**: Creates one PR per repo on Gitea. Pollers watch for approvals/rejections.
- **Understand-review**: Triages rejection feedback as small (targeted fixes) or large (structural changes).
- **Revision**: Small fixes skip scrutiny; large changes go through the full plan-scrutinize loop.

## Sandboxed Execution

When `HOTO_SANDBOX_CLAUDE=true`, all Claude subprocesses run inside Docker sandbox containers:

- One sandbox container per task, started before plan phase
- Claude CLI runs via `docker exec -i` into the sandbox
- CI/lint also runs inside the sandbox (Docker-in-Docker via mounted socket)
- MCP knowledge base access via HTTP/SSE transport (port 7778)
- Credentials copied into sandbox from host
- Sandbox image: `Dockerfile.sandbox` (Debian + Bun + Claude CLI + Docker CLI)

Key env vars for containerized deployment:
- `HOTO_SANDBOX_CLAUDE=true` - Enable sandboxed execution
- `HOTO_WORKSPACE_HOST` - Host-side path of the workspace (e.g. `${PWD}/data`); used for sandbox bind mounts
- `HOTO_MCP_HTTP_PORT` - Port for MCP HTTP server (default: 7778)

## Multi-Repo Tasks (Child Task Architecture)

Tasks can span multiple repositories. When no `-r` flag is specified, all registered repos are assigned and the pre-plan phase narrows them.

- **Task creation**: `hoto run "desc" -r repo1 -r repo2` or `!run desc -r repo1 -r repo2`
- **Data model**: `task_repos` tracks which repos a parent task targets. `child_tasks` table stores one child per repo with its own status, blueprint state, PR, and plan excerpt.
- **Planning**: Parent task runs unified plan/scrutinize/finalize across all repos.
- **Execution**: After finalize, parent spawns child tasks (one per repo) that run in parallel. Each child independently implements, runs CI/lint, commits, pushes, and creates its own PR.
- **Plan splitting**: `plan-splitter.ts` extracts per-repo plan excerpts from `[repo-name]` tagged steps. Each child gets the summary + its repo-specific steps + any untagged cross-cutting steps.
- **Context**: Each child carries a `plan_excerpt` (its assignment) and can query the parent's full plan via `parent_task_id` for cross-repo context. Knowledge base and repo relationships are also available.
- **PRs**: One PR per child task, all using the same branch name.
- **Review**: Each child has its own review poller. Rejection triggers revision on that specific child only -- siblings are unaffected.
- **Completion**: Parent marked "committed" when ALL children are "committed". Mixed state (some committed, some error) keeps parent in "waiting_for_children".
- **Retry/Cancel**: Individual children can be retried or cancelled via `POST /tasks/:id/children/:childId/retry` or `/cancel`.
- **Messaging**: Children share the parent's chat channels. Updates are prefixed with `[repo-name]`.
- **Single-repo**: Tasks targeting one repo spawn exactly one child task.

## Repo Relationships

Repos can be related via `POST /repos/:name/relationships` or `!relate <a> <b> <description>`. Relationships are included in plan context so the agent understands cross-repo dependencies.

## Docker Deployment

Hoto and all services run via `docker-compose.yml`:

```sh
docker compose build
docker compose up -d
```

Services: hoto, chromadb, synapse (Matrix), gitea, ollama, sandbox (image build only).

The hoto container needs:
- Docker socket mount (`/var/run/docker.sock`) for sandbox/CI containers
- Claude credentials directory mount (`~/.claude:/root/.claude`) -- read-write so claude can refresh tokens
- Host bind mount `./data:/data` for workspace persistence. Sandboxes are spawned via the host Docker socket and bind-mount only the specific task's subdirectory (`${HOTO_WORKSPACE_HOST}/tasks/<id>`), so the DB and sibling tasks are not visible to the sandbox.

Environment overrides in docker-compose use Docker service names (e.g. `gitea:3777`, `chromadb:8000`, `ollama:11434`).

## Container Secrets

When tasks run inside Docker containers, those containers often need host credentials (API keys, auth files, SSH keys, etc.).

### How it works

1. **DB table**: `container_secrets` stores per-repo secret requirements.
2. **Manual registration** via `POST /repos/:name/secrets`
3. **Auto-discovery**: When CI/lint fails, `secret-discovery.ts` scans output for missing credentials.
4. **Mounting**: `setupTaskContainer()` in `docker-exec.ts` passes verified secrets as `-e` or `-v` flags.

### API endpoints

- `GET /repos/:name/secrets` - list secrets for a repo
- `POST /repos/:name/secrets` - add a secret (manual, auto-verified)
- `PATCH /repos/:name/secrets/:id` - update verified/description
- `DELETE /repos/:name/secrets/:id` - remove a secret
