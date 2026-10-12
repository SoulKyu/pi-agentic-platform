import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { Logger } from "../../kernel/logger.ts";
import { type Exports, SESSION_ID_PATTERN, TOKEN_PATTERN } from "./exports.ts";

/** What makes an exported transcript a file to save, never a page of the pap origin (ADR 0006). */
const EXPORT_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
export const EXPORT_CSP = "sandbox; default-src 'none'";

const FALLBACK_NAME = "pap-session";
const TITLE_CODE_POINTS = 64;
// Characters a file system or a header has a use for, and format and control characters (bidi marks among them).
const UNSAFE_IN_NAME = /[\\/:*?"<>|]|[\p{Cc}\p{Cf}]/gu;
// encodeURIComponent throws on a lone surrogate.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ASCII_SAFE = /[A-Za-z0-9 ._-]/;

/**
 * `Content-Disposition` of the download: always an attachment. The name comes from the session's name when it has one:
 * an ASCII fallback (`filename`, no quote, separator or control character can be in it) and the RFC 5987 form
 * (`filename*`, percent-encoded UTF-8) for the full text. Without a usable title it is a fixed name.
 */
export function contentDispositionOf(title: string | null | undefined): string {
  const clean = [
    ...(title ?? "")
      .replace(LONE_SURROGATE, "\ufffd")
      .replace(UNSAFE_IN_NAME, (found) => (/^[\p{Cc}\p{Cf}]$/u.test(found) ? "" : "_"))
      .replace(/^[.\s]+/u, "")
      .trim(),
  ]
    .slice(0, TITLE_CODE_POINTS)
    .join("")
    .trimEnd();
  if (clean === "") return `attachment; filename="${FALLBACK_NAME}.html"`;
  const ascii = [...clean].map((char) => (ASCII_SAFE.test(char) ? char : "_")).join("");
  const asciiName = /[A-Za-z0-9]/.test(ascii) ? ascii : FALLBACK_NAME;
  const encoded = encodeURIComponent(`${clean}.html`).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}.html"; filename*=UTF-8''${encoded}`;
}

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

export function mountExportRoute(
  app: Hono,
  deps: {
    exports: Exports;
    authenticate(cookieHeader: string | undefined): { userId: string } | null;
    logger: Logger;
  },
): void {
  app.get("/api/sessions/:sessionId/export/:token", async (c) => {
    // Hono runs this handler for HEAD too; a HEAD must not spend the single-use token.
    if (c.req.method !== "GET") return notFound(c);
    const caller = deps.authenticate(c.req.header("cookie"));
    if (!caller) return c.json({ error: { code: "unauthenticated" } }, 401);
    const sessionId = c.req.param("sessionId");
    const token = c.req.param("token");
    // The shape is checked before any lookup, and nothing of the URL ever becomes a path: the file is the one
    // `prepare` chose. Whatever is wrong gets the same answer.
    if (!SESSION_ID_PATTERN.test(sessionId) || !TOKEN_PATTERN.test(token)) return notFound(c);
    // Single use: the token is gone before the file is read, whatever happens next.
    const taken = deps.exports.take(token, sessionId, caller.userId);
    if (!taken) return notFound(c);
    let file;
    try {
      file = await open(taken.path, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      deps.logger.warn(code === "ENOENT" ? "export_file_missing" : "export_read_failed", { code });
      return notFound(c);
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("not a file");
      // The file is unlinked while it is held open: nothing is left on disk whatever becomes of the response.
      await rm(taken.path, { force: true });
      const stream = file.createReadStream();
      stream.once("error", (error: NodeJS.ErrnoException) => {
        // The browser gave up (a cancelled download) is not a disk problem.
        if (error.code === "ABORT_ERR") deps.logger.info("export_aborted");
        else deps.logger.warn("export_read_failed", { code: error.code ?? "unknown" });
      });
      c.set("ownCsp", EXPORT_CSP);
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          ...EXPORT_HEADERS,
          "content-disposition": contentDispositionOf(taken.title),
          "content-length": String(stat.size),
          "content-security-policy": EXPORT_CSP,
        },
      });
    } catch (error) {
      deps.logger.warn("export_read_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      await file.close().catch(() => undefined);
      await rm(taken.path, { force: true }).catch(() => undefined);
      return notFound(c);
    }
  });
}
