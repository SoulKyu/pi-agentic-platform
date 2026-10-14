import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import { attachmentDisposition } from "../../kernel/http/content-disposition.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { FilesService } from "./service.ts";

const INLINE_IMAGES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;
export const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
export const RAW_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};
const RAW_NAME = { fallback: "pap-file", suffix: "", leadingDot: "underscore" } as const;

export function rawContent(
  path: string,
  size: number,
  download: boolean,
): { type: string; disposition: string | null } {
  const image = INLINE_IMAGES[extname(path).slice(1).toLowerCase()];
  if (!download && image !== undefined && size <= MAX_INLINE_BYTES) return { type: image, disposition: null };
  return { type: "application/octet-stream", disposition: attachmentDisposition(basename(path), RAW_NAME) };
}

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

/**
 * `GET /files/raw?path=<abs>[&download=1]` (M8R32, M8R33): a file of the caller's project as an inline image or a download,
 * never as a page of pap's origin. The route authenticates, decodes, asks the service for the open file and maps its error.
 */
export function mountRawRoute(
  app: Hono,
  deps: {
    readonly caller: HttpCaller;
    readonly service: Pick<FilesService, "openRaw">;
    readonly logger: Logger;
  },
): void {
  app.get("/files/raw", async (c) => {
    const caller = deps.caller(c, "files:read");
    if (caller instanceof Response) return caller;
    const path = c.req.query("path");
    if (path === undefined) return notFound(c);
    let opened;
    try {
      opened = await deps.service.openRaw(caller, path);
    } catch (error) {
      if (error instanceof PapError && error.code === "not_found") return notFound(c);
      throw error;
    }
    const { handle, size } = opened;
    const { type, disposition } = rawContent(path, size, c.req.query("download") === "1");
    const headers: Record<string, string> = {
      ...RAW_HEADERS,
      "content-type": type,
      "content-length": String(size),
      "content-security-policy": RAW_CSP,
    };
    if (disposition !== null) headers["content-disposition"] = disposition;
    c.set("ownCsp", RAW_CSP);
    // Hono runs this handler for HEAD too: no stream, so nothing is left open.
    if (c.req.method === "HEAD" || size === 0) {
      await handle.close();
      return new Response(null, { status: 200, headers });
    }
    // Up to the size announced at the open: a log that grows meanwhile never overruns content-length.
    const stream = handle.createReadStream({ start: 0, end: size - 1 });
    stream.once("error", (error: NodeJS.ErrnoException) => {
      deps.logger.warn("raw_read_failed", { code: error.code ?? "unknown" });
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
  });
}
