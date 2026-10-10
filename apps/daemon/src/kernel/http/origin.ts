import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originAllowed(origin: string | null | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof origin === "string" && allowed.has(origin);
}

export function originGuard(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && !originAllowed(c.req.header("origin"), allowed)) {
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    await next();
  };
}
