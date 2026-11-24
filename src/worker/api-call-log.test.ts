import { expect, test } from "bun:test";
import type { ApiCallRecord } from "../github/types.ts";
import { memoryDb } from "../store/test-db.ts";
import { SqliteApiCallLog } from "./api-call-log.ts";

function call(overrides: Partial<ApiCallRecord>): ApiCallRecord {
  return {
    at: new Date("2026-11-23T12:00:00Z"),
    resource: "rest",
    workClass: "notifications",
    request: "GET /notifications",
    status: 200,
    cost: null,
    remaining: 4999,
    resetAt: null,
    durationMs: 10,
    ...overrides,
  };
}

test("spend matches the governor's rules: 304s are free, GraphQL counts cost", () => {
  const log = new SqliteApiCallLog(memoryDb());
  log.append(call({}));
  log.append(call({ status: 304 }));
  log.append(call({ status: 0 }));
  log.append(call({ at: new Date("2026-11-23T10:00:00Z") }));
  log.append(call({ resource: "graphql", workClass: "enrich", cost: 7 }));
  log.append(call({ resource: "graphql", workClass: "enrich", cost: 3 }));

  const since = new Date("2026-11-23T11:00:00Z");
  expect(log.spendSince("rest", since)).toBe(2);
  expect(log.spendSince("graphql", since)).toBe(10);
});
