# Hoto (Helm of the Overlord)

Multi-repo, multi-agent one-shot task manager. Built with Bun + Hono + SQLite.

## Conventions

- Runtime: Bun (use `bun run`, `bun test`, never `npm` or `npx`)
- No emojis in code or output
- Structured logging via src/shared/logger.ts (signature: `logger.info(msg, data?)`)
- ULIDs for task and agent run IDs
- All paths should use the workspace directory (~/.hoto-workspace by default, /data in Docker)
- Daemon runs on port 7777 by default

## Project Structure

- `src/index.ts` - Entry point: routes to CLI or daemon based on args
- `src/daemon/` - Hono HTTP server, routes
- `src/cli/` - CLI arg parsing and commands
- `src/gitea/` - Gitea REST client, PR creation, review polling
- `src/knowledge/` - SQLite DB, schema, search, indexing
- `src/mcp/` - MCP server (stdio + HTTP/SSE) for knowledge base access
- `src/messaging/` - Chat bot integration (Matrix, Discord)
- `src/orchestrator/` - Blueprint engine, task/child-task runners, agent nodes
- `src/orchestrator/child-task-runner.ts` - Per-repo child task execution
- `src/orchestrator/plan-splitter.ts` - Extracts per-repo plan excerpts
- `src/prompts/` - Markdown prompt templates per pipeline stage
- `src/workspace/` - Workspace directory, git operations, Docker container management
- `src/shared/` - Types, config, logger

## Architecture

### Single-repo tasks
```
plan -> scrutinize -> finalize -> implement -> CI/lint -> review -> commit
```

### Multi-repo tasks (child task architecture)
```
Parent: pre-plan -> plan -> scrutinize -> finalize -> spawn children -> wait
  Child A: implement -> CI/lint -> PR -> review (independent)
  Child B: implement -> CI/lint -> PR -> review (independent)
```

- Children run in parallel, fail independently
- Each child gets a `plan_excerpt` (its repo's portion of the parent plan)
- Parent completes when all children are committed
- Individual children can be retried or cancelled

### Key tables
- `tasks` - Parent tasks (planning + orchestration)
- `child_tasks` - Per-repo execution (implement + CI + review)
- `task_repos` - Which repos a parent task targets
- `repos` - Registered repositories with auto-detected commands

## Docker Deployment

```sh
docker compose build
docker compose up -d
```

Services: hoto, chromadb, synapse (Matrix), gitea, ollama, sandbox (image build only).

## Sandboxed Execution

When `HOTO_SANDBOX_CLAUDE=true`, Claude subprocesses run inside Docker sandbox containers. CI/lint also runs inside the sandbox via Docker-in-Docker.

## Container Secrets

`container_secrets` table stores per-repo secret requirements. Auto-discovery scans CI/lint output for missing credentials. Only verified secrets are mounted.

### API endpoints

- `GET /repos/:name/secrets` - list secrets
- `POST /repos/:name/secrets` - add a secret
- `PATCH /repos/:name/secrets/:id` - update
- `DELETE /repos/:name/secrets/:id` - remove
- `GET /tasks/:id/children` - list child tasks
- `POST /tasks/:id/children/:childId/cancel` - cancel a child
- `POST /tasks/:id/children/:childId/retry` - retry a failed child
