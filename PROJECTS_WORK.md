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
- `POST /projects` — create project (requires `title`, `description`; optional `architecture_notes`)
- `PATCH /projects/:id` — update allowed fields: `title`, `description`, `status`, `architecture_notes`, `carry_over_notes`

**`src/daemon/server.ts`**
- Imported and mounted `projects` route at `/projects`

**`src/shared/types.ts`**
- Added `Project` interface
- Added `ProjectDetail` interface (extends `Project` with `tasks` array)

**`tests/projects.test.ts`** (new file)
- 11 tests covering all CRUD endpoints, validation, 404 handling, task association

### Project schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  architecture_notes TEXT,
  carry_over_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Tasks gain an optional `project_id TEXT REFERENCES projects(id)` column.

### API contract

```
GET  /projects          -> Project[]
GET  /projects/:id      -> ProjectDetail (includes tasks[])
POST /projects          -> Project (201)
PATCH /projects/:id     -> Project
```

---

## Step 2: Activation and State Machine (TODO)

- Wire up project state progression: after a task reaches `committed`, automatically fire the next pending task in the project
- Add `order` column or implicit ordering on tasks within a project
- Carry `carry_over_notes` forward from one task's output to the next
- Add messaging commands for project management (`!project create`, `!project status`)
- UI: activate the Projects tab with create/edit forms and state controls
