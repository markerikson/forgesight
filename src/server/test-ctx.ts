import { parseConfigText } from "../config/load.ts";
import { memoryDb } from "../store/test-db.ts";
import type { ServerCtx } from "./ctx.ts";

/** A server context over one migrated in-memory database, used for both reads and writes. */
export function testCtx(now: Date, overrides: Partial<ServerCtx> = {}): ServerCtx {
  const db = overrides.db ?? memoryDb();
  return {
    db,
    config: parseConfigText("{}"),
    configError: null,
    now: () => now,
    writeDb: () => db,
    ...overrides,
  };
}
