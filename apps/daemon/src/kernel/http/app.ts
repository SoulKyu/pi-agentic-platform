import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { isReadOnlyError } from "../db/read-only.ts";
import type { Logger } from "../logger.ts";
import { isHookRequest } from "./hook-path.ts";
import { originGuard, type OriginRefused } from "./origin.ts";
import { createStaticHandler, isSpaRoute } from "./static.ts";

declare module "hono" {
  interface ContextVariableMap {
    /** A route that answers with a Content-Security-Policy of its own (the export download, ADR 0006). */
    ownCsp?: string;
    /** The policy also covers a non-2xx answer the route chose to send (a page of its own, not a thrown error). */
    ownCspOnError?: boolean;
  }
}

export interface HttpAppOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly staticRoot: string | null;
  readonly logger: Logger;
  /** True only when this process terminates TLS itself: HSTS is sent then and never on plain HTTP (R73). */
  readonly servesTls?: boolean;
  /** Called for every request refused for its Origin: the composition root logs it, rate-limited. */
  readonly onOriginRefused?: OriginRefused;
  mount(app: Hono): void;
  wsProbe(c: Context): Response | Promise<Response>;
}

/** 180 days, no includeSubDomains: the header must not pin other services on the same host name (R73). */
const HSTS = "max-age=15552000";

// The CSP of an app that renders model output (R74). `connect-src 'self'` covers the same-origin ws/wss.
const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};

// The token of an export download is a credential until it is used: it is never logged.
const loggablePath = (path: string): string => path.replace(/(\/export\/)[^/]+$/, "$1[redacted]");

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

// Routes and WebSocket live under these prefixes: a miss is a 404, never index.html, so a typo in an
// API path cannot be masked by the SPA fallback (R78).
const RESERVED_PREFIXES = [
  "/auth",
  "/api",
  "/files",
  "/upload",
  "/hooks",
  "/metrics",
  "/ws",
  "/fonts",
  "/github",
];
function isReserved(path: string): boolean {
  const forms = [path];
  try {
    forms.push(decodeURIComponent(path));
  } catch {
    // An undecodable path is refused by the static handler anyway.
  }
  return forms.some((form) =>
    RESERVED_PREFIXES.some((prefix) => form === prefix || form.startsWith(`${prefix}/`)),
  );
}

// Scheme and client address come from the socket only: no X-Forwarded-* / Forwarded header is read (R72).
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  // A route that answers with a policy of its own keeps it, on a successful answer only: registered first, so that this part runs
  // after `secureHeaders` has set the global one. Every other route, and an error page, keeps the global policy.
  app.use("*", async (c, next) => {
    await next();
    const own = c.get("ownCsp");
    if (own !== undefined && (c.res.ok || c.get("ownCspOnError") === true))
      c.res.headers.set("content-security-policy", own);
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: CONTENT_SECURITY_POLICY,
      strictTransportSecurity: options.servesTls === true ? HSTS : false,
    }),
  );
  app.use("*", originGuard(options.allowedOrigins, options.onOriginRefused, isHookRequest));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  options.mount(app);
  app.get("/ws", (c) => options.wsProbe(c));
  if (options.staticRoot) {
    const serve = createStaticHandler(options.staticRoot);
    app.get("*", (c) => {
      const path = c.req.path;
      if (isReserved(path)) return notFound(c);
      const hit = serve(path === "/" ? "/index.html" : path);
      if (hit) return hit;
      if (!isSpaRoute(path)) return notFound(c);
      return serve("/index.html") ?? notFound(c);
    });
  }
  app.notFound(notFound);
  app.onError((error, c) => {
    // Body limits and malformed bodies surface as HTTPException; they are the client's mistake, not a 500 (R77).
    if (error instanceof HTTPException && error.status === 413) {
      return c.json({ error: { code: "payload_too_large" } }, 413);
    }
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: { code: "bad_request" } }, 400);
    }
    // A database written by a newer pap is read-only here: say so (as the RPC does) instead of a bare 500.
    if (isReadOnlyError(error)) {
      options.logger.warn("http_read_only", { path: loggablePath(c.req.path) });
      return c.json({ error: { code: "read_only" } }, 503);
    }
    options.logger.error("http_error", { err: error, path: loggablePath(c.req.path) });
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}
