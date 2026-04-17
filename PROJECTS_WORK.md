# Projects Feature Work Log

## Overview

Adding a "Project" entity to hoto to support larger, multi-task feature work broken into 2-3 sequential tasks. Projects track overarching goals, architecture decisions, and carry-over notes between task stages.

## Step 1: DB, API Endpoints (COMPLETE)

### Changes made

**`src/knowledge/schema.ts`**
- Added `MIGRATIONS_V6` with `projects` table and `idx_projects_status` index
- Added `ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)` to `ALTER_MIGRATIONS`
- Added `runMigrations` call for V6 block (before `ALTER_MIGRATIONS` loop so FK reference resolves)

**`src/daemon/routes/projects.ts`** (new file)
- `GET /projects` — list all projects, ordered by `created_at DESC`
- `GET /projects/:id` — get project with associated tasks array
- `POST /projects` — create project (requires `description`; optional `architecture_notes`)
- `PATCH /projects/:id` — update allowed fields: `title`, `description`, `status`, `architecture_notes`, `carry_over_notes`
- `DELETE /projects/:id` — remove a project

**`src/daemon/server.ts`**
- Imported and mounted `projects` route at `/projects`

**`src/shared/types.ts`**
- Added `Project` interface
- Added `ProjectDetail` interface (extends `Project` with `tasks` array)

**`tests/projects.test.ts`** (new file)
- Tests covering all CRUD endpoints, validation, 404 handling, task association, milestones array shape

### Project schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  milestones TEXT NOT NULL DEFAULT '[]',
  current_milestone INTEGER NOT NULL DEFAULT 0,
  repo_id TEXT,
  source_sender_id TEXT,
  source_provider TEXT,
  architecture_notes TEXT,
  carry_over_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Tasks gain an optional `project_id TEXT REFERENCES projects(id)` column.

### API contract

```
GET    /projects          -> Project[]
GET    /projects/:id      -> ProjectDetail (includes tasks[])
POST   /projects          -> Project (201)
PATCH  /projects/:id      -> Project
DELETE /projects/:id      -> { id, deleted: true }
```

---

## Step 2: Activation and State Machine (COMPLETE)

### Changes made

**`src/projects/planner.ts`** (new file)
- `planProject(description, repoNames, mcpConfigPath)` — invokes Claude to produce a structured milestone plan
- Returns `{ title, milestones: [{ description }] }`

**`src/projects/runner.ts`** (new file)
- `createProject(description, repoNames, sourceSenderId, sourceProvider, preAllocatedId?)` — inserts a project row, runs the planner, saves milestones, calls `advanceProject` to kick off the first milestone task
- `advanceProject(projectId)` — POSTs to `/tasks` (daemon API) to create the next milestone's task; saves `task_id` on the milestone; logs warning and leaves `task_id` null on failure (for retry on restart)
- `onTaskCompleted(taskId)` — called when a task reaches `committed`; finds the matching `in_progress` project, marks the milestone complete, captures carry-over notes from the latest agent run (truncated to 2000 chars), increments `current_milestone`, and either advances to the next milestone or marks the project `completed` and sends a messaging notification
- `resumeProjects()` — called on daemon startup; for each `in_progress` project: retries `advanceProject` if `task_id` is null, or calls `onTaskCompleted` if the task is already `committed`

**`src/daemon/routes/projects.ts`**
- `POST /projects` now fires `createProject` in the background (non-blocking) so the route returns immediately with `status: 'planning'`
- Added `parseProjectRow` helper so all responses return `milestones` as a parsed array (not a raw JSON string) and `current_milestone` as a number

**`tests/projects.test.ts`**
- Added assertions: all response shapes include `milestones` as an array and `current_milestone` as a number

**`tests/projects-runner.test.ts`** (new file)
- Unit tests for `onTaskCompleted`, `resumeProjects`, and `advanceProject`
- Mocks `globalThis.fetch` so no live daemon is required
- Covers: milestone advancement, project completion, carry-over notes capture, no-op on non-matching task, retry on null `task_id`, `onTaskCompleted` triggered from `resumeProjects` when task is already committed, graceful fetch failure handling

---

## Step 3: Remaining Work (TODO)

### Carry-over notes quality
- `onTaskCompleted` currently uses `agent_runs.output` sliced to 2000 chars as carry-over notes. This is raw agent output and may be noisy.
- Consider a structured extraction pass: after a task commits, run a short Claude call to summarise the key decisions, changed files, and open questions from the agent run into a clean carry-over note for the next milestone.

### UI integration
- The Projects tab in the web UI is not yet wired to these endpoints.
- Add a project list view (`GET /projects`), a create form (`POST /projects`), and a detail view (`GET /projects/:id`) showing milestones with status indicators.
- Add project status badge and milestone progress bar.

### Messaging flow improvements
- `!project create <description>` command: currently fires and returns the project id immediately; the user gets no update when planning completes. Add a follow-up message once `createProject` resolves (title + milestone count).
- `!project status <id>` command: show milestone list with completed/in-progress/pending indicators.
- `!project list` command: list active projects.

### Milestone task linking in UI
- `GET /projects/:id` already returns `tasks[]` associated via `project_id`, but milestones reference tasks by `task_id` inside the JSON blob. Consider joining these in the API response so the UI can render a milestone-to-task link without client-side joining.
