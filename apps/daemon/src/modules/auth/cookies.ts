import type { CookieOptions } from "hono/utils/cookie";
import { DEVICE_COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_PATH } from "./known-device.ts";

export const SESSION_COOKIE = "pap_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// URL.hostname keeps the brackets of an IPv6 literal.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

// R24: Secure unless the request is plain http to a loopback host, where Safari/WebKit would drop it.
// The URL is the one the socket and Host header built: no forwarded header is consulted (R72), and an
// unreadable URL is treated as not loopback.
export function cookieNeedsSecure(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname);
  } catch {
    return true;
  }
}

// R24b: the configured public origin counts too. A proxy that terminates TLS may rewrite Host to a loopback
// name, which would make the request look like plain loopback http while the browser is on https.
// `secureByConfig` is cookieNeedsSecure(publicOrigin), computed once at startup.
const isPlainHttp = (url: string): boolean => {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
};

/** `insecureHttp` (`--insecure-http`): any plain-HTTP request gets a cookie without Secure, for LAN testing. */
export function sessionCookieAttributes(
  requestUrl: string,
  secureByConfig: boolean,
  insecureHttp = false,
): CookieOptions {
  return {
    httpOnly: true,
    secure: insecureHttp ? !isPlainHttp(requestUrl) : secureByConfig || cookieNeedsSecure(requestUrl),
    sameSite: "Strict",
    path: "/",
  };
}

/** The known-device cookie (M5R79): the session cookie's flags, limited to the auth routes, and kept for 400 days. */
export function deviceCookieOptions(
  requestUrl: string,
  secureByConfig: boolean,
  insecureHttp = false,
): CookieOptions {
  return {
    ...sessionCookieAttributes(requestUrl, secureByConfig, insecureHttp),
    path: DEVICE_COOKIE_PATH,
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Every value of the cookie `name`, in header order (a sibling path can plant a second one). */
export function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
  }
  return values;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
