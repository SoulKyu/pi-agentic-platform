import { type IncomingMessage, request as httpRequest } from "node:http"; // http only behind `test`
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { errorOf } from "./client.ts";

/** Where GitHub keeps job logs: the only hosts a log redirect may name. */
export const LOG_HOST_SUFFIXES = Object.freeze([".actions.githubusercontent.com", ".blob.core.windows.net"]);
export const LOG_LIMITS = Object.freeze({ totalMs: 15_000, downloadBytes: 32 * 1024 * 1024 });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface JobLog {
  readonly text: string;
  readonly truncated: boolean;
}

/** The last `max` bytes of `bytes` as text, starting on a character boundary. */
export function tailText(bytes: Buffer, max: number, complete: boolean): JobLog {
  if (bytes.length <= max && complete) return { text: bytes.toString("utf8"), truncated: false };
  let start = Math.max(0, bytes.length - max);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

export interface JobLogDeps {
  readonly clock: Clock;
  readonly logger?: Logger | undefined;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  /** Tests only: a redirect may also name the fake GitHub's own origin. */
  readonly test: boolean;
  readonly lookup: unknown;
  readonly allow: (ip: string) => boolean;
  readonly keep: number;
}

export function createJobLog(deps: JobLogDeps): (path: string, auth: { value: string }) => Promise<JobLog> {
  const { clock } = deps;
  const refuse = (word: string): null => {
    deps.logger?.warn(word); // a fixed word: the signed URL is a secret and is never logged
    return null;
  };

  /** The second hop's URL, or null when it is not an allowed storage host. */
  function target(location: string | undefined): URL | null {
    let url: URL;
    try {
      url = new URL(location ?? "");
    } catch {
      return refuse("github_log_redirect_refused");
    }
    if (deps.test && (url.origin === deps.apiOrigin || url.origin === deps.webOrigin)) return url;
    const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const ok =
      url.protocol === "https:" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      isIP(bare) === 0 &&
      LOG_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
    return ok ? url : refuse("github_log_redirect_refused");
  }

  return (path, auth) =>
    new Promise<JobLog>((resolve, reject) => {
      let settled = false;
      let active: { destroy(): void } | undefined;
      const timerRef: { handle?: TimerHandle } = {};
      const finish = (outcome: JobLog | PapError): void => {
        if (settled) return;
        settled = true;
        if (timerRef.handle) clock.clearTimeout(timerRef.handle);
        active?.destroy();
        if (outcome instanceof PapError) reject(outcome);
        else resolve(outcome);
      };
      const unavailable = (): void => finish(new PapError("github_unavailable"));
      timerRef.handle = clock.setTimeout(unavailable, LOG_LIMITS.totalMs);

      function stream(res: IncomingMessage): void {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > LOG_LIMITS.downloadBytes) return unavailable();
        let tail = Buffer.alloc(0);
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > LOG_LIMITS.downloadBytes) return unavailable();
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > deps.keep + 4) tail = tail.subarray(tail.length - (deps.keep + 4));
        });
        res.on("end", () => finish(tailText(tail, deps.keep, total <= deps.keep)));
        res.on("error", unavailable);
        res.on("close", unavailable); // after `end` this is a no-op: `finish` already ran
      }

      function hop(url: URL, headers: Record<string, string>, second: boolean): void {
        const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
        if (isIP(bare) !== 0 && !deps.allow(bare)) return unavailable();
        let req;
        try {
          req = (url.protocol === "http:" ? httpRequest : httpsRequest)(
            url,
            { method: "GET", headers, agent: false, lookup: deps.lookup as never },
            (res) => {
              active = res;
              const status = res.statusCode ?? 0;
              if (REDIRECTS.has(status)) {
                if (second) {
                  refuse("github_log_redirect_twice");
                  return unavailable();
                }
                const next = target(res.headers.location);
                res.destroy();
                if (!next) return unavailable();
                // The signed URL carries its own authority: no Authorization, no GitHub headers.
                return hop(next, { accept: "*/*", "accept-encoding": "identity" }, true);
              }
              if (status < 200 || status >= 300)
                return finish(second ? new PapError("github_unavailable") : errorOf(status, res.headers));
              stream(res);
            },
          );
        } catch {
          return unavailable();
        }
        active = req;
        req.on("error", unavailable);
        req.end();
      }

      hop(
        new URL(path, deps.apiOrigin),
        {
          accept: "application/vnd.github+json",
          "user-agent": "pap",
          "x-github-api-version": "2022-11-28",
          "accept-encoding": "identity",
          authorization: `Bearer ${auth.value}`,
        },
        false,
      );
    });
}
