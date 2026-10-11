import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originAllowed(origin: string | null | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof origin === "string" && allowed.has(origin);
}

/** Told of every request the Origin check refused, with the Origin it carried (undefined when there was none). */
export type OriginRefused = (via: "http" | "ws", origin: string | undefined) => void;

export function originGuard(allowed: ReadonlySet<string>, onRefused?: OriginRefused): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && !originAllowed(origin, allowed)) {
      onRefused?.("http", origin);
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    await next();
  };
}
