/** What a provider request is allowed to do, shared by discovery, test and the price lookup (M7R66, M7R67). */

export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the deadline, not the run's cancel, ended the request. */
  timedOut(): boolean;
  /** Clears the timer and the listener: call on every path. */
  dispose(): void;
}

/** One signal for a request: the run's cancel, or the deadline. The timer is cleared by `dispose`. */
export function deadline(parent: AbortSignal, ms: number): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  timer.unref();
  const cancel = () => controller.abort();
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", cancel);
    },
  };
}

/**
 * The body as text, or `null` when it is over `maxBytes`: a declared length over the cap is refused before any read, and
 * a stream is cancelled at the first chunk that crosses the cap, so nothing past the cap is ever held.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The class of an HTTP status: a redirect or anything else unusable is `network` (the key must never follow one). */
export const statusClassOf = (status: number): "http_4xx" | "http_5xx" | "network" =>
  status >= 500 && status < 600 ? "http_5xx" : status >= 400 && status < 500 ? "http_4xx" : "network";

/** A fetch that never follows a redirect and sends no cookies, so a key cannot travel to another host. */
export const strictFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error", credentials: "omit" });
