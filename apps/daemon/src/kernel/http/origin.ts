import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originAllowed(origin: string | null | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof origin === "string" && allowed.has(origin);
}

/** Told of every request the Origin check refused, with the Origin it carried (undefined when there was none). */
export type OriginRefused = (via: "http" | "ws", origin: string | undefined) => void;

/**
 * `exempt` names the requests that authenticate themselves and never with a cookie: M10's `POST /hooks/<id>` (the
 * trigger's secret, `isHookRequest`). Every other unsafe request still needs an allowed Origin.
 */
export function originGuard(
  allowed: ReadonlySet<string>,
  onRefused?: OriginRefused,
  exempt: (method: string, path: string) => boolean = () => false,
): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (
      !SAFE_METHODS.has(c.req.method) &&
      !exempt(c.req.method, c.req.path) &&
      !originAllowed(origin, allowed)
    ) {
      onRefused?.("http", origin);
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    await next();
  };
}
