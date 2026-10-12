import type { Credential } from "../../kernel/ws/ws-server.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";

const MAX_BEARER_CHARS = 128;
// Scheme case-insensitive, exactly one space, no whitespace inside the value (M5R71).
const BEARER = new RegExp(`^bearer (\\S{1,${MAX_BEARER_CHARS}})$`, "i");

/**
 * The one credential of a request: the session cookie or the `Authorization: Bearer` value, read from those two
 * headers only (never a query string, M5R71). Both present: "conflict". A header that is not a well-formed bearer
 * counts as absent, so a Basic header or a 129-character value cannot hide or replace a cookie.
 */
export function credentialOf(headers: {
  readonly cookie?: string | undefined;
  readonly authorization?: string | undefined;
}): Credential | "conflict" | undefined {
  const cookie = readCookie(headers.cookie, SESSION_COOKIE);
  const bearer = headers.authorization === undefined ? undefined : BEARER.exec(headers.authorization)?.[1];
  const hasCookie = cookie !== undefined && cookie !== "";
  if (hasCookie && bearer !== undefined) return "conflict";
  if (bearer !== undefined) return { kind: "bearer", value: bearer };
  return hasCookie ? { kind: "cookie", value: cookie } : undefined;
}
