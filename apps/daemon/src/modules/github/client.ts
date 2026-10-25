import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { type ClientRequest, request as httpRequest } from "node:http"; // only behind `test`
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { GITHUB_LIMITS, GITHUB_WEB_ORIGIN, PapError } from "@pap/contracts";
import type { z } from "zod";
import { createJobLog, type JobLog } from "./client-log.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { blockedStrict } from "../../kernel/net/address-strict.ts";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const CLIENT_LIMITS = Object.freeze({ totalMs: 15_000, maxBytes: 4 * 1024 * 1024 });
const REFUSED_CODE = "EGITHUBADDR";

export type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface GithubClientOptions {
  readonly clock: Clock;
  readonly apiOrigin?: string;
  readonly webOrigin?: string;
  /** Tests only: the origins are the fake GitHub on loopback, so plain http and loopback addresses pass. Without it, only the real origins are accepted. */
  readonly test?: boolean;
  readonly resolve?: Resolver;
  readonly logger?: Logger;
}

export interface Auth {
  readonly kind: "bearer";
  readonly value: string;
}
export interface RequestOptions {
  readonly origin?: "api" | "web";
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly auth?: Auth;
  readonly body?: unknown;
}
export interface GithubClient {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  /** The JSON answer, parsed with `schema`; a failure is a `PapError` (github_unavailable, not_found, conflict, capacity, forbidden). */
  json<S extends z.ZodType>(schema: S, options: RequestOptions): Promise<z.output<S>>;
  /** The answer as text (a job log), same errors. */
  text(options: RequestOptions): Promise<string>;
  /** A job log: follows one redirect to GitHub's log storage and keeps only the last 64 KiB of what it streams. */
  log(path: string, auth: Auth): Promise<JobLog>;
}

interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A 401: the credential itself is refused (revoked or expired). `github_unavailable` to everyone, but a user-token check can tell it from an outage. */
export class GithubUnauthorized extends PapError {
  constructor() {
    super("github_unavailable");
  }
}

/** What a non-2xx answer means to pap. A rate limit is `capacity`, a refused permission `forbidden`. */
export function errorOf(status: number, headers: Raw["headers"]): PapError {
  const rateLimited =
    status === 429 ||
    (status === 403 && (headers["x-ratelimit-remaining"] === "0" || "retry-after" in headers));
  if (rateLimited) return new PapError("capacity");
  if (status === 403) return new PapError("forbidden");
  if (status === 404) return new PapError("not_found");
  if (status === 409 || status === 422) return new PapError("conflict");
  return new PapError("github_unavailable"); // 401, 5xx, anything odd
}

function validOrigin(value: string, test: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("github origin must be a bare origin");
  if (url.protocol !== "https:" && !(test && url.protocol === "http:"))
    throw new Error("github origin must be https");
  return url.origin;
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const test = options.test === true;
  const apiOrigin = validOrigin(options.apiOrigin ?? GITHUB_API_ORIGIN, test);
  const webOrigin = validOrigin(options.webOrigin ?? GITHUB_WEB_ORIGIN, test);
  if (!test && (apiOrigin !== GITHUB_API_ORIGIN || webOrigin !== GITHUB_WEB_ORIGIN))
    throw new Error("github origins can only change for a test");
  const allow = (ip: string): boolean => (test ? true : !blockedStrict(ip));
  const resolve: Resolver = options.resolve ?? ((host, opts, cb) => dnsLookup(host, opts, cb));

  const lookup = (host: string, opts: { all?: boolean }, callback: (...args: never[]) => void): void => {
    const done = callback as unknown as (
      error: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    resolve(host, { all: true }, (error, addresses) => {
      if (error) return done(error, "");
      if (addresses.length === 0 || addresses.some((entry) => !allow(entry.address)))
        return done(Object.assign(new Error("address refused"), { code: REFUSED_CODE }), "");
      const [first] = addresses;
      return opts.all || first === undefined
        ? done(null, addresses)
        : done(null, first.address, first.family);
    });
  };

  function send(request: RequestOptions): Promise<Raw> {
    const base = request.origin === "web" ? webOrigin : apiOrigin;
    const url = new URL(request.path, base);
    if (url.origin !== base) return Promise.reject(new PapError("github_unavailable"));
    const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(bare) !== 0 && !allow(bare)) return Promise.reject(new PapError("github_unavailable"));
    const payload = request.body === undefined ? null : Buffer.from(JSON.stringify(request.body), "utf8");
    return new Promise((resolvePromise, reject) => {
      const limit: { timer?: TimerHandle } = {};
      let req: ClientRequest | undefined;
      let settled = false;
      const finish = (outcome: Raw | PapError): void => {
        if (settled) return;
        settled = true;
        if (limit.timer) options.clock.clearTimeout(limit.timer);
        if (outcome instanceof PapError) reject(outcome);
        else resolvePromise(outcome);
      };
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        req = (url.protocol === "http:" ? httpRequest : httpsRequest)(
          url,
          {
            method: request.method ?? "GET",
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "pap",
              "x-github-api-version": "2022-11-28",
              "accept-encoding": "identity",
              ...(request.auth ? { authorization: `Bearer ${request.auth.value}` } : {}),
              ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
            },
            agent: false,
            lookup: lookup as never,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const fail = (): void => {
              res.destroy();
              finish(new PapError("github_unavailable"));
            };
            if (status >= 300 && status < 400) return fail(); // never followed
            const declared = Number(res.headers["content-length"]);
            if (Number.isFinite(declared) && declared > CLIENT_LIMITS.maxBytes) return fail();
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > CLIENT_LIMITS.maxBytes) return fail();
              chunks.push(chunk);
            });
            res.on("end", () =>
              finish({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
            );
            res.on("error", () => finish(new PapError("github_unavailable")));
            res.on("close", () => finish(new PapError("github_unavailable")));
          },
        );
      } catch {
        return finish(new PapError("github_unavailable"));
      }
      const sent = req;
      limit.timer = options.clock.setTimeout(() => {
        sent.destroy();
        finish(new PapError("github_unavailable"));
      }, CLIENT_LIMITS.totalMs);
      sent.on("error", () => finish(new PapError("github_unavailable")));
      sent.end(payload ?? undefined);
    });
  }

  async function ok(request: RequestOptions): Promise<Raw> {
    const raw = await send(request);
    if (raw.status === 401) throw new GithubUnauthorized();
    if (raw.status < 200 || raw.status >= 300) throw errorOf(raw.status, raw.headers);
    return raw;
  }
  const log = createJobLog({
    clock: options.clock,
    logger: options.logger,
    apiOrigin,
    webOrigin,
    test,
    lookup,
    allow,
    keep: GITHUB_LIMITS.checkLogBytes,
  });
  return {
    apiOrigin,
    webOrigin,
    async json(schema, request) {
      const raw = await ok(request);
      try {
        const parsed = schema.safeParse(JSON.parse(raw.body));
        if (parsed.success) return parsed.data;
      } catch {
        // falls through: an answer that is not the expected JSON is GitHub being unavailable
      }
      throw new PapError("github_unavailable");
    },
    log: (path, auth) => log(path, auth),
    async text(request) {
      return (await ok(request)).body;
    },
  };
}
