export interface Pm2AppState {
  status: string;
  uptimeMs: number;
  restarts: number;
}

interface Pm2ListEntry {
  name?: unknown;
  pm2_env?: { status?: unknown; pm_uptime?: unknown; restart_time?: unknown };
}

/** Reads one app's state from `pm2 jlist` output. `pm_uptime` is the start time in epoch ms. */
export function pm2AppState(jlist: string, name: string, nowMs: number): Pm2AppState | null {
  const list: unknown = JSON.parse(jlist);
  if (!Array.isArray(list)) return null;
  const entry = (list as Pm2ListEntry[]).find((e) => e.name === name);
  const env = entry?.pm2_env;
  if (!env) return null;
  const started = typeof env.pm_uptime === "number" ? env.pm_uptime : nowMs;
  return {
    status: typeof env.status === "string" ? env.status : "unknown",
    uptimeMs: Math.max(0, nowMs - started),
    restarts: typeof env.restart_time === "number" ? env.restart_time : 0,
  };
}

export type Readiness = "ready" | "waiting" | "failed";

/** An app is ready once it has stayed online for `minUptimeMs`; `errored` or `stopped` is final. */
export function readiness(state: Pm2AppState | null, minUptimeMs: number): Readiness {
  if (!state) return "waiting";
  if (state.status === "errored" || state.status === "stopped") return "failed";
  return state.status === "online" && state.uptimeMs >= minUptimeMs ? "ready" : "waiting";
}
