import { Database } from "bun:sqlite";
import { config } from "../shared/config";
import { runMigrations } from "./schema";
import { logger } from "../shared/logger";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  logger.info("Opening database", { path: config.dbPath });
  _db = new Database(config.dbPath, { create: true });
  runMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
