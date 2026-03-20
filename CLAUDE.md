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

## Docker

Hoto runs as a container via `Dockerfile` (multi-stage: deps, web-build, runtime).
The container needs the `claude` CLI at runtime -- installed via `bun install -g @anthropic-ai/claude-code`.

To authenticate Claude Code inside the container, mount the host's credentials:
```
docker run -v ~/.claude/.credentials.json:/root/.claude/.credentials.json:ro ...
```

## Container Secrets

When tasks run inside Docker containers (via Dockerfile or docker-compose in the target repo), those containers often need host credentials (API keys, auth files, SSH keys, etc.).

### How it works

1. **DB table**: `container_secrets` stores per-repo secret requirements. Each row has:
   - `secret_type`: `env_var` (pass as `-e`) or `auth_file` (bind mount as `-v :ro`)
   - `key`: env var name (e.g. `ANTHROPIC_API_KEY`) or file identifier (e.g. `.npmrc`)
   - `value_source`: `host_env` (read from host `process.env`) or `host_file` (read from path on host)
   - `host_path`: path on host for file secrets (e.g. `~/.aws/credentials`)
   - `container_path`: mount target inside container (defaults to `host_path`)
   - `discovered_by`: `manual` or `auto`
   - `verified`: whether a human has confirmed this secret is needed

2. **Manual registration** via API:
   ```
   POST /repos/:name/secrets
   { "secret_type": "env_var", "key": "NPM_TOKEN", "value_source": "host_env" }
   ```
   ```
   POST /repos/:name/secrets
   { "secret_type": "auth_file", "key": ".npmrc", "value_source": "host_file",
     "host_path": "/home/user/.npmrc", "container_path": "/root/.npmrc" }
   ```

3. **Auto-discovery**: When CI, lint, or docker build fails inside a container, `secret-discovery.ts` scans the output for patterns indicating missing credentials:
   - "environment variable X is not set"
   - `process.env.X is undefined`
   - Python `KeyError: 'X'`
   - Known API key env var names (ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, etc.)
   - ENOENT / "not found" for common auth file paths (~/.aws, ~/.ssh, ~/.npmrc, etc.)
   - npm 401/403 errors, pip/poetry auth failures

   Discovered secrets are saved with `discovered_by='auto'` and `verified=false`. They are NOT mounted until verified (only `verified=true` secrets are used).

4. **Mounting**: `setupTaskContainer()` in `docker-exec.ts` queries verified secrets for the repo and passes them as `-e` or `-v` flags to `docker run`. For docker-compose, env vars are passed through the shell environment.

### API endpoints

- `GET /repos/:name/secrets` - list secrets for a repo
- `POST /repos/:name/secrets` - add a secret (manual, auto-verified)
- `PATCH /repos/:name/secrets/:id` - update verified/description
- `DELETE /repos/:name/secrets/:id` - remove a secret

### Key files

- `src/knowledge/schema.ts` - `container_secrets` table definition
- `src/daemon/routes/secrets.ts` - CRUD routes + `getRepoSecrets()` helper
- `src/workspace/docker-exec.ts` - mounts secrets when starting containers
- `src/workspace/secret-discovery.ts` - pattern-based auto-discovery from failure output
