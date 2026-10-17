import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type ClientRequest } from "node:http"; // only when the loopback switch is on and the URL is http://127.0.0.1
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import type { Clock, TimerHandle } from "../../../kernel/clock.ts";

/** Idle limit of one socket and total limit of one request: well under the outbox's 30 s deadline, which also aborts. */
const SOCKET_IDLE_MS = 10_000;
const TOTAL_MS = 12_000;
const DRAIN_MAX_BYTES = 8 * 1024;

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
        return callback(Object.assign(new Error("address refused"), { code: "EPUSHADDR" }), "");
      const [first] = addresses;
      return options.all || first === undefined
        ? callback(null, addresses)
        : callback(null, first.address, first.family);
    });
  };
}

/** Reads a response only to empty it: the stream is destroyed as soon as more than `max` bytes have arrived. */
export function drainCapped(stream: Readable, max: number): void {
  let seen = 0;
  stream.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > max) stream.destroy();
  });
}

export type SendResult =
  { status: number; retryAfter: string | null } | { error: "address" | "timeout" | "network" };

export interface SendArgs {
  href: string;
  body: Buffer;
  headers: Record<string, string>;
  signal: AbortSignal;
  allowLoopback: boolean;
  allowAddress: (ip: string) => boolean;
  resolve?: Resolver;
  /** The total limit runs on the Clock (tests advance a fake one). */
  clock: Clock;
  totalMs?: number;
  /** Tests only: the socket idle limit. */
  idleMs?: number;
}

/** One POST. Never throws: every failure is a result. No redirect is followed, no body is kept, TLS is verified. */
export function sendOnce(args: SendArgs): Promise<SendResult> {
  let url: URL;
  try {
    url = new URL(args.href);
  } catch {
    return Promise.resolve({ error: "address" });
  }
  const http = args.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (!http && url.protocol !== "https:") return Promise.resolve({ error: "address" }); // https.request would throw
  const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  // net.connect never calls the lookup hook for an IP literal: judge it here
  if (!http && isIP(bare) !== 0 && !args.allowAddress(bare)) return Promise.resolve({ error: "address" });
  return new Promise((resolve) => {
    let req: ClientRequest | undefined;
    const limit: { timer?: TimerHandle } = {};
    const settle = (result: SendResult): void => {
      if (limit.timer) args.clock.clearTimeout(limit.timer);
      resolve(result);
    };
    try {
      req = (http ? httpRequest : httpsRequest)(
        url,
        {
          method: "POST",
          headers: { ...args.headers, "content-length": String(args.body.length) },
          agent: false, // no pooled sockets between pushes
          timeout: args.idleMs ?? SOCKET_IDLE_MS,
          signal: args.signal,
          // rejectUnauthorized stays at its default: TLS is verified
          lookup: http
            ? undefined
            : (guardedLookup(args.resolve ?? systemResolver, args.allowAddress) as never),
        },
        (res) => {
          drainCapped(res, DRAIN_MAX_BYTES); // drained, never kept or logged
          res.on("error", () => {});
          const done = () =>
            settle({
              status: res.statusCode ?? 0,
              retryAfter: res.headers["retry-after"]?.toString() ?? null,
            });
          res.on("end", done);
          res.on("close", done);
        },
      );
    } catch {
      return settle({ error: "network" }); // a synchronous throw never reaches the outbox (its log would carry the endpoint)
    }
    const sent = req;
    limit.timer = args.clock.setTimeout(() => {
      sent.destroy();
      settle({ error: "timeout" });
    }, args.totalMs ?? TOTAL_MS);
    sent.on("timeout", () => {
      sent.destroy();
      settle({ error: "timeout" });
    });
    sent.on("error", (error: NodeJS.ErrnoException) =>
      settle({
        error: error.code === "EPUSHADDR" ? "address" : args.signal.aborted ? "timeout" : "network",
      }),
    );
    sent.end(args.body);
  });
}
