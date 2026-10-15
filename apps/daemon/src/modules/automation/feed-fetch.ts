import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import {
  FEED_MAX_REDIRECTS,
  feedUrlRefusal,
  guardedLookup,
  isPublicAddress,
  redirectTarget,
  type Resolver,
} from "./net-guard.ts";

export type FeedFetchCode =
  | "feed_address"
  | "feed_redirects"
  | "feed_too_large"
  | "feed_timeout"
  | "feed_tls"
  | "feed_network"
  | "not_a_feed"
  | `feed_status_${number}`;
export type FeedFetchResult =
  | { readonly ok: true; readonly body: string; readonly finalUrl: string }
  | { readonly ok: false; readonly code: FeedFetchCode; readonly retry: boolean };

/** C §6.4: 10 s for the whole chain, 1 MiB of body. */
export const FEED_FETCH = { timeoutMs: 10_000, maxBytes: 1024 * 1024 } as const;

export interface FeedFetchDeps {
  readonly resolve: Resolver;
  /** Tests only: the address rule. Production never passes it, so the loopback and the private ranges stay refused. */
  readonly allowed?: (address: string) => boolean;
  readonly request?: typeof httpsRequest;
  /** Tests only: the certificate authority of the local server. Production uses Node's own store. */
  readonly ca?: Buffer;
  readonly clock: Clock;
  /** Aborted: the socket is destroyed and the answer is `feed_timeout`, retry. */
  readonly signal?: AbortSignal;
}

const CONTENT_TYPES =
  /^(?:application\/(?:rss|atom|rdf)\+xml|application\/xml|text\/xml|text\/plain|(?:application|binary)\/octet-stream)$/i;
const TLS_CODES = /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/;
const REFUSAL_CODE: Readonly<Record<string, FeedFetchCode>> = { bad_redirect: "feed_redirects" };

const fail = (code: FeedFetchCode, retry = false): FeedFetchResult => ({ ok: false, code, retry });

function failureOf(error: unknown): FeedFetchResult {
  const found = [error, ...(error instanceof AggregateError ? error.errors : [])];
  const codes = found.map((one) => (one as { code?: unknown } | null)?.code);
  if (codes.includes("EFEEDADDR")) return fail("feed_address");
  if (codes.some((code) => typeof code === "string" && TLS_CODES.test(code))) return fail("feed_tls");
  return fail("feed_network", true);
}

/**
 * Fetches one feed (M10R74): https only, the address judged before connecting and again at every redirect (five at most),
 * the connection made to an address the guard saw, 10 s for the whole chain on the Clock, 1 MiB counted as it streams.
 * Never throws. A refusal is `retry: false`; a timeout, a network error, a 5xx and a 429 are `retry: true`.
 */
export function fetchFeed(rawUrl: string, deps: FeedFetchDeps): Promise<FeedFetchResult> {
  const { clock, signal } = deps;
  const allowed = deps.allowed ?? isPublicAddress;
  const send = deps.request ?? httpsRequest;
  if (signal?.aborted) return Promise.resolve(fail("feed_timeout", true));

  return new Promise<FeedFetchResult>((resolve) => {
    let settled = false;
    let call: ClientRequest | null = null;
    let timer: TimerHandle | null = null;

    const finish = (result: FeedFetchResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clock.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      call?.destroy();
      resolve(result);
    };
    const onAbort = (): void => finish(fail("feed_timeout", true));
    timer = clock.setTimeout(onAbort, FEED_FETCH.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    function read(url: URL, res: IncomingMessage): void {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 299)
        return finish(fail(`feed_status_${status}`, status >= 500 || status === 429));
      const type = (res.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      const encoding = (res.headers["content-encoding"] ?? "identity").toLowerCase();
      if ((type !== "" && !CONTENT_TYPES.test(type)) || (encoding !== "identity" && encoding !== ""))
        return finish(fail("not_a_feed"));
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > FEED_FETCH.maxBytes) return finish(fail("feed_too_large"));
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > FEED_FETCH.maxBytes) return finish(fail("feed_too_large"));
        chunks.push(chunk);
      });
      res.on("end", () =>
        finish({ ok: true, body: Buffer.concat(chunks).toString("utf8"), finalUrl: url.href }),
      );
      res.on("error", () => finish(fail("feed_network", true)));
      res.on("close", () => finish(fail("feed_network", true)));
    }

    function hop(url: URL, followed: number): void {
      const refusal = feedUrlRefusal(url, allowed);
      if (refusal !== null) return finish(fail(REFUSAL_CODE[refusal] ?? "feed_address"));
      const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      let mine: ClientRequest;
      try {
        mine = send({
          protocol: "https:",
          hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          agent: false,
          lookup: guardedLookup(deps.resolve, allowed),
          ca: deps.ca,
          headers: {
            "User-Agent": "pap-feed",
            "Accept-Encoding": "identity",
            Accept:
              "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
          },
        });
      } catch (error) {
        return finish(failureOf(error));
      }
      call = mine;
      // A request we left for a redirect is destroyed on purpose: whatever it still says is not the answer.
      mine.on("error", (error) => call === mine && finish(failureOf(error)));
      mine.on("response", (res: IncomingMessage) => {
        const target = redirectTarget(url, res.statusCode ?? 0, res.headers.location, allowed);
        if (target === null) return read(url, res);
        res.destroy();
        mine.destroy();
        if ("refused" in target) return finish(fail(REFUSAL_CODE[target.refused] ?? "feed_address"));
        if (followed >= FEED_MAX_REDIRECTS) return finish(fail("feed_redirects"));
        hop(target.url, followed + 1);
      });
      mine.end();
    }

    let first: URL;
    try {
      first = new URL(rawUrl);
    } catch {
      return finish(fail("feed_address"));
    }
    hop(first, 0);
  });
}
