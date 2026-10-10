import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// After one decoding pass: NUL, backslash, a still-encoded escape (double encoding), an empty segment
// and `.` / `..` segments are traversal vehicles. They are refused, never normalised or "fixed".
const REFUSED = /[\0\\]|%[0-9a-f]{2}|\/\/|\/\.{1,2}(?:\/|$)/i;

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

// Hono hands over its path with %25 and reserved escapes still encoded, so this is the only full decode.
function cleanPath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rooted = decoded.startsWith("/") ? decoded : `/${decoded}`;
  return REFUSED.test(rooted) ? null : rooted;
}

// A navigation the SPA may answer with index.html: not an asset or a file, and nothing a refused path
// could hide behind. Everything else that misses on disk is a 404.
export function isSpaRoute(urlPath: string): boolean {
  const clean = cleanPath(urlPath);
  return clean !== null && !clean.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(clean);
}

function locate(realRoot: string, clean: string): { path: string; size: number } | null {
  try {
    const target = resolve(realRoot, `.${clean}`);
    if (!inside(target, realRoot)) return null;
    const real = realpathSync(target);
    if (!inside(real, realRoot)) return null;
    const stats = statSync(real);
    return stats.isFile() ? { path: real, size: stats.size } : null;
  } catch {
    return null;
  }
}

export function createStaticHandler(root: string): (urlPath: string) => Response | null {
  const realRoot = realpathSync(root);
  return (urlPath) => {
    const clean = cleanPath(urlPath);
    const file = clean === null ? null : locate(realRoot, clean);
    if (clean === null || file === null) return null;
    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {
      headers: {
        "content-type": TYPES[extname(file.path)] ?? "application/octet-stream",
        "content-length": String(file.size),
        "cache-control": clean.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
}
