import { FEED_HOSTS, FEED_PATH_PREFIX } from "./feed.ts";

export class FetchRefused extends Error {
  override name = "FetchRefused";
  readonly code: "scheme" | "host" | "redirects" | "status" | "too_large" | "timeout" | "network";
  constructor(code: FetchRefused["code"]) {
    super(`download refused (${code})`);
    this.code = code;
  }
}

export type FetchLike = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

const MAX_REDIRECTS = 3;

/**
 * Releases a body we will not read. Cancelling can reject with the stream's stored raw error; the refusal code already decided
 * by the caller stands and the raw error never leaves (nothing remote is logged or rethrown).
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // best effort: the connection is dropped with the response either way
  }
}

/**
 * GET with a deadline, an https-and-host check on EVERY hop (redirects are followed by hand), no cookies or credentials,
 * and a byte cap enforced while reading (a lying Content-Length changes nothing). The body is returned as bytes; it is never
 * logged and a failure carries a code only, never the remote text.
 */
export async function fetchLimited(
  start: string,
  options: {
    maxBytes: number;
    timeoutMs: number;
    userAgent: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
  },
): Promise<Uint8Array> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  // The deadline always applies; a caller's stop signal is added to it, never a replacement.
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchRefused("scheme");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== ""
    )
      throw new FetchRefused("scheme");
    if (!FEED_HOSTS.has(parsed.hostname)) throw new FetchRefused("host");
    // The start is always a project release URL; a redirect that stays on github.com must stay under the project's releases.
    if (
      (hop === 0 && parsed.hostname !== "github.com") ||
      (parsed.hostname === "github.com" && !parsed.pathname.startsWith(FEED_PATH_PREFIX))
    )
      throw new FetchRefused("host");
    let response: Response;
    try {
      response = await doFetch(parsed.href, {
        redirect: "manual",
        signal,
        headers: { "user-agent": options.userAgent },
      });
    } catch (error) {
      throw new FetchRefused(
        (error as Error | null)?.name === "TimeoutError" || deadline.aborted ? "timeout" : "network",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await discard(response);
      if (location === null || hop === MAX_REDIRECTS) throw new FetchRefused("redirects");
      try {
        url = new URL(location, parsed).href;
      } catch {
        throw new FetchRefused("redirects");
      }
      continue;
    }
    if (response.status !== 200 || response.body === null) {
      await discard(response);
      throw new FetchRefused("status");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > options.maxBytes) throw new FetchRefused("too_large"); // leaving the loop cancels the stream
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof FetchRefused) throw error;
      throw new FetchRefused(deadline.aborted ? "timeout" : "network");
    }
    return Buffer.concat(chunks);
  }
  throw new FetchRefused("redirects");
}
