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

const ALTER_MIGRATIONS = [
  "ALTER TABLE repos ADD COLUMN index_commit_hash TEXT",
  "ALTER TABLE tasks ADD COLUMN lint_output TEXT",
  "ALTER TABLE tasks ADD COLUMN lint_passed INTEGER",
  "ALTER TABLE tasks ADD COLUMN ci_output TEXT",
  "ALTER TABLE tasks ADD COLUMN ci_passed INTEGER",
  "ALTER TABLE tasks ADD COLUMN use_full_copy INTEGER NOT NULL DEFAULT 0",
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

  for (const sql of ALTER_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists, ignore
    }
  }
}
