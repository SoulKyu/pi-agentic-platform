import type { ImageResult } from "@pap/ui";
import type { PathScope } from "../../stores/reply-ports.ts";
import { findPaths } from "./path-links.ts";

/** The size a reply's image may have (the global constraint for images): 10 MiB, read from the HEAD answer. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
/** A HEAD that has not answered by then is text: a dead daemon must not leave an image pending for good. */
export const IMAGE_HEAD_TIMEOUT_MS = 10_000;
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * Where an image source points, by UX-1's path judgement (UX2-R46): no scheme, no `//`, no query or fragment; decoded
 * once; then exactly one path covering the whole string, inside the session's roots. `image` for the six types,
 * `file` for any other file. `null`: not a file of this session, so the alt text stands in.
 */
export function imageTarget(
  src: string,
  scope: PathScope | null,
): { readonly kind: "image" | "file"; readonly path: string } | null {
  if (scope === null || SCHEME.test(src) || src.startsWith("//") || /[?#]/u.test(src)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    return null; // malformed percent-encoding
  }
  if (/[?#]/u.test(decoded)) return null; // an encoded query or fragment character is no part of a file name here
  const spans = findPaths(decoded, scope, true);
  const [span] = spans;
  if (spans.length !== 1 || span === undefined) return null;
  if (span.start !== 0 || span.end !== decoded.length || span.line !== null) return null;
  const extension = span.path.slice(span.path.lastIndexOf(".") + 1).toLowerCase();
  return { kind: IMAGE_EXTENSIONS.has(extension) ? "image" : "file", path: span.path };
}

/** `HEAD /files/raw` (same origin, the session cookie): an image only for a 200, an `image/` type and at most 10 MiB. */
export async function resolveImage(
  src: string,
  scope: PathScope | null,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const target = imageTarget(src, scope);
  if (target === null) return { kind: "text" };
  if (target.kind === "file") return { kind: "file", path: target.path };
  const url = `/files/raw?path=${encodeURIComponent(target.path)}`;
  // The caller's signal and the deadline both stop the request (`AbortSignal.any` is newer than the Safari 16.4 floor).
  const stop = new AbortController();
  const abort = () => stop.abort();
  if (signal?.aborted === true) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS);
  deadline.addEventListener("abort", abort, { once: true });
  try {
    const answer = await fetch(url, {
      method: "HEAD",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: stop.signal,
    });
    const announced = answer.headers.get("content-length");
    const length = announced === null || announced === "" ? Number.NaN : Number(announced);
    const isImage = (answer.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
    const ok = answer.status === 200 && isImage && Number.isInteger(length) && length <= MAX_IMAGE_BYTES;
    return ok ? { kind: "image", url } : { kind: "text" };
  } catch {
    return { kind: "text" };
  } finally {
    signal?.removeEventListener("abort", abort);
    deadline.removeEventListener("abort", abort);
  }
}
