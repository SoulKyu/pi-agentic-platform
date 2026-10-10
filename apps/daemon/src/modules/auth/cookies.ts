import type { CookieOptions } from "hono/utils/cookie";

export const SESSION_COOKIE = "pap_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// URL.hostname keeps the brackets of an IPv6 literal.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

// R24: Secure unless the request is plain http to a loopback host, where Safari/WebKit would drop it.
// The URL is the one the socket and Host header built: no forwarded header is consulted (R72), and an
// unreadable URL is treated as not loopback.
export function cookieNeedsSecure(requestUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(requestUrl);
    return protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname);
  } catch {
    return true;
  }
}

export function sessionCookieAttributes(requestUrl: string): CookieOptions {
  return { httpOnly: true, secure: cookieNeedsSecure(requestUrl), sameSite: "Strict", path: "/" };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
