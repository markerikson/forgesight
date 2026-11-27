// Re-derives every subject view from the stored data, without GitHub calls. Run it after a deploy
// that changes what the pipeline derives without bumping PIPELINE_VERSION. Safe while the worker runs.
// Usage: bun scripts/rederive.ts [--db <path>]
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config/load.ts";
import { configPath } from "../src/config/paths.ts";
import { META } from "../src/core/meta-keys.ts";
import { defaultDbPath, openDb } from "../src/store/db.ts";
import { getMeta } from "../src/store/meta.ts";
import { assertCurrent } from "../src/store/schema-version.ts";
import { rederiveAll } from "../src/worker/derive.ts";
import { consoleLogger } from "../src/worker/scheduler.ts";

const { values } = parseArgs({ options: { db: { type: "string" } } });

const { config, error } = await loadConfig(configPath());
if (error) {
  // The worker would also be running on defaults, but deriving with them hides the real problem.
  console.error(`rederive: config error, fix it first: ${error}`);
  process.exit(1);
}

const path = values.db ?? defaultDbPath();
const db = openDb(path);
let failed = 0;
try {
  assertCurrent(db);
  // Match the worker's effective config, so the stored config hash stays the same.
  const me = config.me ?? getMeta(db, META.viewerLogin) ?? null;
  let lastLog = 0;
  const summary = rederiveAll(db, { ...config, me }, new Date(), consoleLogger, {
    onBatch: (done, total) => {
      if (done === total || performance.now() - lastLog > 2000) {
        lastLog = performance.now();
        console.log(`rederive: ${done}/${total}`);
      }
    },
  });
  failed = summary.failed.length;
  console.log(
    `rederive: ${path}: ${summary.subjects} subjects, ${summary.changed} views changed, ${failed} failed, ${summary.ms}ms`,
  );
  for (const key of summary.failed.slice(0, 20)) console.error(`  failed: ${key}`);
} finally {
  db.close();
}
process.exit(failed > 0 ? 1 : 0);
