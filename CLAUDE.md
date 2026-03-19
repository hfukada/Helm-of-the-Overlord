# Hoto (Helm of the Overlord)

Multi-repo, multi-agent one-shot task manager. Built with Bun + Hono + SQLite.

## Conventions

- Runtime: Bun (use `bun run`, `bun test`, never `npm` or `npx`)
- No emojis in code or output
- Structured logging via src/shared/logger.ts
- ULIDs for task and agent run IDs
- All paths should use the workspace directory (~/.hoto-workspace by default)
- Daemon runs on port 7777 by default

## Project Structure

- `src/index.ts` - Entry point: routes to CLI or daemon based on args
- `src/daemon/` - Hono HTTP server, routes, WebSocket
- `src/cli/` - CLI arg parsing and commands
- `src/knowledge/` - SQLite DB, schema, embeddings (future), search
- `src/orchestrator/` - Blueprint engine, subprocess management, agent nodes
- `src/workspace/` - Workspace directory and git operations
- `src/shared/` - Types, config, logger

## Key Commands

- `bun run src/index.ts daemon start` - Start daemon
- `bun run src/index.ts "task description"` - Submit task
- `bun run src/index.ts status` - List tasks
