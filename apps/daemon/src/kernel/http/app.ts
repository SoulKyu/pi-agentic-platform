import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Logger } from "../logger.ts";
import { originGuard } from "./origin.ts";
import { createStaticHandler, isSpaRoute } from "./static.ts";

export interface HttpAppOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly staticRoot: string | null;
  readonly logger: Logger;
  mount(app: Hono): void;
  wsProbe(c: Context): Response | Promise<Response>;
}

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

// Scheme and client address come from the socket only: no X-Forwarded-* / Forwarded header is read (R72).
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  app.use("*", secureHeaders());
  app.use("*", originGuard(options.allowedOrigins));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  options.mount(app);
  app.get("/ws", (c) => options.wsProbe(c));
  if (options.staticRoot) {
    const serve = createStaticHandler(options.staticRoot);
    app.get("*", (c) => {
      const path = c.req.path;
      const hit = serve(path === "/" ? "/index.html" : path);
      if (hit) return hit;
      if (!isSpaRoute(path)) return notFound(c);
      return serve("/index.html") ?? notFound(c);
    });
  }
  app.notFound(notFound);
  app.onError((error, c) => {
    options.logger.error("http_error", { err: error, path: c.req.path });
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}
