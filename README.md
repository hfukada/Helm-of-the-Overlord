# Hoto (Helm of the Overlord)

Multi-repo, multi-agent one-shot task manager. Describe a task in plain text, and Hoto spins up Claude subagents to plan, implement, lint, test, and prepare a commit -- all in an isolated git worktree. Review the diff in the browser, leave inline comments, and commit when ready.

## How it works

1. Register one or more git repos with `hoto repos add`
2. Start the daemon with `hoto daemon start`
3. Submit a task: `hoto "add a retry mechanism to the HTTP client"`
4. Hoto creates a worktree branch and runs a pipeline:

```
plan -> implement -> lint -> fix_lint -> push -> CI -> fix_ci -> review -> commit
```

5. When the pipeline reaches **review**, open the web UI to inspect the diff, leave comments, and accept/commit

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude` must be on your PATH)
- [Ollama](https://ollama.ai) with `nomic-embed-text` (for knowledge search -- optional)
- Git

## Install

```sh
git clone <repo-url> && cd helm-of-the-overlord
bun install
bun link   # makes `hoto` available globally
```

### Build the web UI

```sh
cd src/web && bun install && bun run build
```

Or from the project root:

```sh
bun run build:web
```

## Quick start

```sh
# Start the daemon (runs on port 7777)
hoto daemon start

# Register a repo
hoto repos add /path/to/your/project

# Submit a task
hoto "refactor the database connection pool to use async initialization"

# Watch progress
hoto status

# Open the web UI
hoto open
```

## CLI reference

```
hoto "task description"           Submit a task
hoto -f task.txt                  Submit from file
hoto -f task.txt -r repo-name    Target specific repo
hoto status                       List tasks
hoto status <id>                  Task detail + diff
hoto cancel <id>                  Cancel a task
hoto ask "question" [-r repo]     Query knowledge base
hoto repos                        List tracked repos
hoto repos add /path/to/repo     Add + index repo
hoto repos remove <name>          Untrack repo
hoto repos reindex [name]         Re-index repo knowledge
hoto tokens                       Token usage summary
hoto open [task-id]               Open web UI in browser
hoto daemon start|stop|status    Daemon management
```

## Web UI

The web UI is served at `http://127.0.0.1:7777/app/` when the daemon is running.

- **Task list** with live status updates
- **Blueprint timeline** showing pipeline progress
- **Agent activity stream** (thinking, tool use, output)
- **Diff review** with unified/split view, file collapsing, and inline comments
- **Commit dialog** with editable message and push
- **Token dashboard** with daily breakdown and cost tracking

## Architecture

```
src/
  index.ts                   Entry point (routes to CLI or daemon)
  daemon/
    server.ts                Hono HTTP server + static file serving
    routes/                  REST endpoints (tasks, agents, repos, tokens, comments, commits, knowledge)
  cli/
    index.ts                 Command router
    commands/                One file per command
  orchestrator/
    blueprint.ts             Pipeline state machine
    task-runner.ts           Runs blueprint nodes in sequence
    subprocess.ts            Spawns Claude subagents
    context-builder.ts       Assembles prompts from knowledge base
    nodes/
      agentic/               plan, implement, fix-lint, fix-ci (Claude-driven)
      deterministic/         lint, push, git-ops, docker-compose (shell commands)
  knowledge/
    db.ts                    SQLite connection
    schema.ts                Migrations
    embeddings.ts            Ollama vector embeddings
    indexer.ts               Repo content indexer
    repo-parser.ts           Auto-detect language/framework/commands
    search.ts                Hybrid vector + keyword search
  workspace/
    manager.ts               Workspace directory management
    git.ts                   Worktree, diff, commit operations
    docker.ts                Docker Compose support
  shared/
    types.ts                 TypeScript types
    config.ts                Configuration
    logger.ts                Structured logging
  web/                       React SPA (Vite + React 19 + Tailwind CSS 4)
    src/
      App.tsx                Layout shell
      api.ts                 Typed API client
      components/            UI components
```

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `HOTO_WORKSPACE` | `~/.hoto-workspace` | Workspace directory (DB, worktrees, PID file) |
| `HOTO_PORT` | `7777` | Daemon HTTP port |
| `HOTO_HOST` | `127.0.0.1` | Daemon bind address |
| `HOTO_MODEL` | `claude-sonnet-4-6` | Default Claude model for subagents |

## Tech stack

- **Runtime**: Bun (bun:sqlite, Bun.spawn, Bun.serve)
- **HTTP**: Hono
- **Database**: SQLite (WAL mode)
- **AI**: Claude CLI subagents with streaming JSON output
- **Embeddings**: Ollama + nomic-embed-text (768 dimensions)
- **Web UI**: React 19, Tailwind CSS 4, Vite, react-diff-view

## License

MIT
