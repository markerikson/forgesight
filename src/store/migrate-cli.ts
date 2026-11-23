import { defaultDbPath, openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";

const path = defaultDbPath();
const db = openDb(path);
try {
  const { from, to } = runMigrations(db);
  console.log(from === to ? `${path} is current (version ${to}).` : `${path}: migrated ${from} → ${to}.`);
} finally {
  db.close();
}
