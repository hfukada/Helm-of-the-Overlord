import type { Database } from "bun:sqlite";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    description TEXT,
    build_cmd TEXT,
    test_cmd TEXT,
    run_cmd TEXT,
    lint_cmd TEXT,
    language TEXT,
    framework TEXT,
    docker_compose_path TEXT,
    metadata TEXT DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    repo_id INTEGER REFERENCES repos(id),
    status TEXT NOT NULL DEFAULT 'pending',
    blueprint_state TEXT,
    branch_name TEXT,
    source TEXT NOT NULL DEFAULT 'cli',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    node_name TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    prompt TEXT NOT NULL,
    output TEXT,
    token_input INTEGER DEFAULT 0,
    token_output INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS agent_stream (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS diff_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    file_path TEXT NOT NULL,
    line_number INTEGER,
    side TEXT DEFAULT 'right',
    body TEXT NOT NULL,
    resolved INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS token_usage_daily (
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    PRIMARY KEY (date, model)
  )`,

  `CREATE TABLE IF NOT EXISTS repo_relationships (
    source_repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    target_repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (source_repo_id, target_repo_id, relationship)
  )`,

  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    source_file TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_repo ON knowledge_chunks(repo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_type ON knowledge_chunks(chunk_type)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(repo_id, source_file)`,

  `CREATE TABLE IF NOT EXISTS ask_queries (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    answer TEXT,
    sources TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ask_stream (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ask_query_id TEXT NOT NULL REFERENCES ask_queries(id),
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const MIGRATIONS_V2 = [
  `CREATE TABLE IF NOT EXISTS messaging_channels (
    task_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'matrix',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS messaging_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    source TEXT NOT NULL,
    sender_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS task_input_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    question TEXT NOT NULL,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_input_requests_task ON task_input_requests(task_id, status)`,

  `CREATE TABLE IF NOT EXISTS container_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    secret_type TEXT NOT NULL CHECK (secret_type IN ('env_var', 'auth_file')),
    key TEXT NOT NULL,
    value_source TEXT NOT NULL CHECK (value_source IN ('host_env', 'host_file')),
    host_path TEXT,
    container_path TEXT,
    description TEXT,
    discovered_by TEXT NOT NULL DEFAULT 'manual' CHECK (discovered_by IN ('manual', 'auto')),
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo_id, secret_type, key)
  )`,
];

const MIGRATIONS_V3 = [
  `CREATE TABLE IF NOT EXISTS task_repos (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'target',
    PRIMARY KEY (task_id, repo_id)
  )`,

  `CREATE TABLE IF NOT EXISTS task_prs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL,
    pr_url TEXT NOT NULL,
    last_review_id INTEGER NOT NULL DEFAULT 0,
    last_comment_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    UNIQUE(task_id, repo_id)
  )`,
];

const MIGRATIONS_V4 = [
  `CREATE TABLE IF NOT EXISTS child_tasks (
    id TEXT PRIMARY KEY,
    parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    status TEXT NOT NULL DEFAULT 'pending',
    blueprint_state TEXT,
    branch_name TEXT,
    plan_excerpt TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    ci_output TEXT,
    ci_passed INTEGER,
    lint_output TEXT,
    lint_passed INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_task_id, repo_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_child_tasks_parent ON child_tasks(parent_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_child_tasks_status ON child_tasks(parent_task_id, status)`,

  `CREATE TABLE IF NOT EXISTS agent_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    has_tool_use INTEGER NOT NULL DEFAULT 0,
    tool_names TEXT,
    text_output TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    stop_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_turns_run ON agent_turns(agent_run_id)`,
];

const MIGRATIONS_V5 = [
  `CREATE TABLE IF NOT EXISTS task_ci_lint_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    child_task_id TEXT,
    run_type TEXT NOT NULL CHECK(run_type IN ('ci','lint')),
    output TEXT,
    passed INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ci_lint_runs_task
    ON task_ci_lint_runs(task_id, run_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ci_lint_runs_child
    ON task_ci_lint_runs(child_task_id, run_type, created_at)`,
];

const MIGRATIONS_V6 = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    architecture_notes TEXT,
    carry_over_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`,
];

const ALTER_MIGRATIONS = [
  "ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)",
  "ALTER TABLE repos ADD COLUMN index_commit_hash TEXT",
  "ALTER TABLE tasks ADD COLUMN lint_output TEXT",
  "ALTER TABLE tasks ADD COLUMN lint_passed INTEGER",
  "ALTER TABLE tasks ADD COLUMN ci_output TEXT",
  "ALTER TABLE tasks ADD COLUMN ci_passed INTEGER",
  "ALTER TABLE tasks ADD COLUMN use_full_copy INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN gitea_pr_number INTEGER",
  "ALTER TABLE tasks ADD COLUMN gitea_pr_url TEXT",
  "ALTER TABLE tasks ADD COLUMN gitea_last_review_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN gitea_last_comment_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE repos ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE repos ADD COLUMN docker_image TEXT",
  "ALTER TABLE repos ADD COLUMN ci_on_host INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN source_sender_id TEXT",
  "ALTER TABLE tasks ADD COLUMN source_provider TEXT",
  "ALTER TABLE agent_runs ADD COLUMN child_task_id TEXT",
  "ALTER TABLE agent_runs ADD COLUMN session_id TEXT",
];

export function runMigrations(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  for (const sql of MIGRATIONS_V2) {
    db.exec(sql);
  }

  for (const sql of MIGRATIONS_V3) {
    db.exec(sql);
  }

  for (const sql of MIGRATIONS_V4) {
    db.exec(sql);
  }

  for (const sql of MIGRATIONS_V5) {
    db.exec(sql);
  }

  for (const sql of MIGRATIONS_V6) {
    db.exec(sql);
  }

  for (const sql of ALTER_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists, ignore
    }
  }

  // Migrate messaging_channels to composite PK (task_id, provider) if needed
  const hasOldSchema = db.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messaging_channels'"
  ).get() as { sql: string } | null;
  if (hasOldSchema?.sql && !hasOldSchema.sql.includes("PRIMARY KEY (task_id, provider)")) {
    db.exec(`CREATE TABLE IF NOT EXISTS messaging_channels_v2 (
      task_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'matrix',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, provider)
    )`);
    db.exec(
      `INSERT OR IGNORE INTO messaging_channels_v2 (task_id, channel_id, provider, created_at)
       SELECT task_id, channel_id, provider, created_at FROM messaging_channels`
    );
    db.exec("DROP TABLE messaging_channels");
    db.exec("ALTER TABLE messaging_channels_v2 RENAME TO messaging_channels");
  }

  // Backfill task_repos from existing tasks.repo_id (only where the repo still exists)
  db.exec(
    `INSERT OR IGNORE INTO task_repos (task_id, repo_id, role)
     SELECT t.id, t.repo_id, 'target'
     FROM tasks t JOIN repos r ON r.id = t.repo_id
     WHERE t.repo_id IS NOT NULL`
  );

  // Backfill task_prs from existing tasks with gitea_pr_number
  db.exec(
    `INSERT OR IGNORE INTO task_prs (task_id, repo_id, pr_number, pr_url, last_review_id, last_comment_id)
     SELECT t.id, t.repo_id, t.gitea_pr_number, COALESCE(t.gitea_pr_url, ''), t.gitea_last_review_id, t.gitea_last_comment_id
     FROM tasks t JOIN repos r ON r.id = t.repo_id
     WHERE t.gitea_pr_number IS NOT NULL AND t.repo_id IS NOT NULL`
  );
}
