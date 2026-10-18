import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { FontsStore } from "./store.ts";

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

/**
 * `GET /fonts/<slug>/<file>`: the files a family recorded, from `$PAP_HOME/fonts`, same origin, read only. The store
 * resolves a name only if the family's own record lists it, so a slug or a file that is not one of ours (a `..`, a
 * case change, another file of the folder) is a 404 and never reaches the file system. Public like the bundled
 * assets: a font file is not a secret and the login page needs it. The CSP is the global one, `font-src 'self'`.
 */
export function mountFonts(app: Hono, store: FontsStore): void {
  app.get("/fonts/:slug/:file", (c) => {
    const hit = store.read(c.req.param("slug"), c.req.param("file"));
    if (hit === null) return notFound(c);
    return new Response(Readable.toWeb(createReadStream(hit.path)) as ReadableStream, {
      headers: {
        "content-type": hit.type,
        "content-length": String(hit.size),
        "cache-control": hit.type === "font/woff2" ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  });
  app.all("/fonts", notFound);
  app.all("/fonts/*", notFound);
}
