import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";

export function memoryDb(): Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}
