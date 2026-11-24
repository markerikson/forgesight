import { getConfig } from "./ctx.ts";

const ALWAYS_ALLOWED = ["localhost", "127.0.0.1", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function forbidden(reason: string): Response {
  return Response.json({ error: reason }, { status: 403 });
}

function requestHost(req: Request): string | null {
  return req.headers.get("host") ?? (URL.canParse(req.url) ? new URL(req.url).host : null);
}

function hostnameOf(host: string): string | null {
  return URL.canParse(`http://${host}`) ? new URL(`http://${host}`).hostname.toLowerCase() : null;
}

/** Rejects requests whose Host is not in `server.allowedHosts` or loopback (DNS rebinding). */
export function hostGuard(req: Request, allowedHosts: readonly string[]): Response | null {
  const host = requestHost(req);
  const name = host ? hostnameOf(host) : null;
  if (!name) return forbidden("missing or invalid Host header");
  const allowed = [...ALWAYS_ALLOWED, ...allowedHosts.map((h) => h.toLowerCase())];
  return allowed.includes(name) ? null : forbidden(`host ${name} is not allowed`);
}

/** Rejects cross-origin writes. Requests without `Origin` pass unless the browser marks them cross-site. */
export function originGuard(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method)) return null;
  const origin = req.headers.get("origin");
  if (origin === null) {
    const site = req.headers.get("sec-fetch-site");
    return site === "cross-site" || site === "same-site" ? forbidden("cross-origin request") : null;
  }
  const host = requestHost(req);
  if (!URL.canParse(origin) || host === null) return forbidden("cross-origin request");
  return new URL(origin).host === host.toLowerCase() ? null : forbidden("cross-origin request");
}

/** Runs every guard; returns the rejection, or null to continue. */
export async function guard(req: Request): Promise<Response | null> {
  const { config } = await getConfig();
  return hostGuard(req, config.server.allowedHosts) ?? originGuard(req);
}
