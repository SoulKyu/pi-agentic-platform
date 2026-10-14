import type { Caller, Permission } from "@pap/contracts";
import type { Context } from "hono";

/** The caller of an HTTP file route, or the response that refuses it (M8R31). */
export type HttpCaller = (c: Context, permission: Permission) => Caller | Response;

/**
 * HTTP file routes are cookie-only: any `Authorization` header is refused (a token uses RPC), and so is a request without a
 * live browser session. A missing permission is `forbidden`.
 */
export function httpCaller(
  authenticateCookieHeader: (header: string | undefined) => Caller | null,
): HttpCaller {
  return (c, permission) => {
    if (c.req.header("authorization") !== undefined)
      return c.json({ error: { code: "unauthenticated" } }, 401);
    const caller = authenticateCookieHeader(c.req.header("cookie"));
    if (caller === null || caller.kind !== "session")
      return c.json({ error: { code: "unauthenticated" } }, 401);
    if (!caller.permissions.has(permission)) return c.json({ error: { code: "forbidden" } }, 403);
    return caller;
  };
}
