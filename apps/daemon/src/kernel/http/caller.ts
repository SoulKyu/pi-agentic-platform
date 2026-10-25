import type { Caller, Permission } from "@pap/contracts";
import type { Context } from "hono";
import type { ClientPathGate } from "../ws/client-path-gate.ts";

/**
 * The caller of an HTTP file route, or the response that refuses it (M8R31). `paths` are the host paths the request names
 * (query or body): a member's request with one outside their box roots is refused here, before the route reads anything.
 */
export type HttpCaller = (
  c: Context,
  permission: Permission,
  paths?: readonly (string | undefined)[],
) => Caller | Response;

/**
 * HTTP file routes are cookie-only: any `Authorization` header is refused (a token uses RPC), and so is a request without a
 * live browser session. A missing permission is `forbidden`.
 */
export function httpCaller(
  authenticateCookieHeader: (header: string | undefined) => Caller | null,
  gate: ClientPathGate,
): HttpCaller {
  return (c, permission, paths = []) => {
    if (c.req.header("authorization") !== undefined)
      return c.json({ error: { code: "unauthenticated" } }, 401);
    const caller = authenticateCookieHeader(c.req.header("cookie"));
    if (caller === null || caller.kind !== "session")
      return c.json({ error: { code: "unauthenticated" } }, 401);
    if (!caller.permissions.has(permission)) return c.json({ error: { code: "forbidden" } }, 403);
    const named = paths.filter((path): path is string => path !== undefined);
    if (!gate.allows(caller.userId, named)) return c.json({ error: { code: "forbidden" } }, 403);
    return caller;
  };
}
