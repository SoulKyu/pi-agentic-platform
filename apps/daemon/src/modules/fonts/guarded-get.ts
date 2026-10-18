import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type ClientRequest } from "node:http"; // only for tests, behind plainHttpForTests
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

/** Total limit of one request, on the Clock (no socket timer). */
const TOTAL_MS = 15_000;
// A browser-like agent: Google answers a browser that takes woff2 with woff2 files.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const REFUSED_CODE = "EFONTADDR";

export type FetchError = "host" | "address" | "timeout" | "network" | "redirect" | "too_large";
export type FetchResult =
  | { readonly ok: true; readonly status: number; readonly body: Buffer }
  | { readonly ok: false; readonly error: FetchError };

export type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

const systemResolver: Resolver = (hostname, options, callback) => dnsLookup(hostname, options, callback);

/** Every answer must pass `allow`; one private answer refuses the name. The socket connects to an address that was checked. */
function guardedLookup(resolve: Resolver, allow: (ip: string) => boolean) {
  return (host: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(host, { all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      if (addresses.length === 0 || addresses.some((entry) => !allow(entry.address)))
        return callback(Object.assign(new Error("address refused"), { code: REFUSED_CODE }), "");
      const [first] = addresses;
      return options.all || first === undefined
        ? callback(null, addresses)
        : callback(null, first.address, first.family);
    });
  };
}

export interface GuardedGetArgs {
  readonly url: string;
  readonly maxBytes: number;
  readonly clock: Clock;
  readonly allowAddress: (ip: string) => boolean;
  readonly resolve?: Resolver;
  /** Tests only: lets an `http://` URL through, to reach a server on loopback. */
  readonly plainHttpForTests?: boolean;
  /** Total limit of this request; at most the default 15 s. */
  readonly totalMs?: number;
}

const failure = (error: FetchError): FetchResult => ({ ok: false, error });

/**
 * One GET. Never throws: every failure is a result. TLS is verified, no redirect is followed, the body is capped while
 * it arrives, and the name is resolved here and every answer judged before the socket connects (the pattern of the
 * push sender). The request carries no cookie, no credential and nothing of the owner's.
 */
export function guardedGet(args: GuardedGetArgs): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return Promise.resolve(failure("address"));
  }
  const plain = args.plainHttpForTests === true && url.protocol === "http:";
  if (!plain && url.protocol !== "https:") return Promise.resolve(failure("address")); // https.request would throw
  const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  // net.connect never calls the lookup hook for an IP literal: judge it here
  if (isIP(bare) !== 0 && !args.allowAddress(bare)) return Promise.resolve(failure("address"));
  return new Promise((resolve) => {
    const limit: { timer?: TimerHandle } = {};
    let req: ClientRequest | undefined;
    let settled = false;
    const settle = (result: FetchResult): void => {
      if (settled) return;
      settled = true;
      if (limit.timer) args.clock.clearTimeout(limit.timer);
      resolve(result);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      req = (plain ? httpRequest : httpsRequest)(
        url,
        {
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept: "text/css,*/*;q=0.1", "accept-encoding": "identity" },
          agent: false, // no pooled sockets
          lookup: guardedLookup(args.resolve ?? systemResolver, args.allowAddress) as never,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            return settle(failure("redirect"));
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > args.maxBytes) {
            res.destroy();
            return settle(failure("too_large"));
          }
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > args.maxBytes) {
              res.destroy();
              return settle(failure("too_large"));
            }
            chunks.push(chunk);
          });
          res.on("end", () => settle({ ok: true, status, body: Buffer.concat(chunks) }));
          res.on("error", () => settle(failure("network")));
          res.on("close", () => settle(failure("network"))); // after "end" the request is settled already
        },
      );
    } catch {
      return settle(failure("network"));
    }
    const sent = req;
    limit.timer = args.clock.setTimeout(
      () => {
        sent.destroy();
        settle(failure("timeout"));
      },
      Math.min(args.totalMs ?? TOTAL_MS, TOTAL_MS),
    );
    sent.on("error", (error: NodeJS.ErrnoException) =>
      settle(failure(error.code === REFUSED_CODE ? "address" : "network")),
    );
    sent.end();
  });
}
