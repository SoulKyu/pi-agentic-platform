import { z } from "zod";
import { resolveChannel, UpdateFeedError, checkForUpdate } from "./cli/update/check.ts";
import { FetchRefused, type FetchLike } from "./cli/update/fetch.ts";
import { opsDir, writeJsonAtomic } from "./cli/ops/paths.ts";
import { join } from "node:path";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";

/**
 * The daily check is on by default since the v1 flip (scripts/release-flip.ts, ADR 0066 and ADR 0076).
 * `PAP_UPDATE_CHECK=0` turns it off, `=1` forces it on.
 */
export const UPDATE_CHECK_DEFAULT = true;

const FIRST_RUN_MS = 10 * 60_000;
const INTERVAL_MS = 24 * 60 * 60_000;

export interface UpdateCheckOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly version: string;
  readonly dev: boolean;
  /** Tests only. */
  readonly fetch?: FetchLike;
  /** Tests only: what `UPDATE_CHECK_DEFAULT` would be. */
  readonly defaultOn?: boolean;
}

function enabled(env: NodeJS.ProcessEnv, defaultOn: boolean): boolean {
  if (env.PAP_UPDATE_CHECK === "1") return true;
  return env.PAP_UPDATE_CHECK === undefined && defaultOn;
}

const failureCode = (error: unknown): string =>
  error instanceof UpdateFeedError || error instanceof FetchRefused ? error.code : "unknown";

/** M6bR22b: the answer and nothing the feed said except the validated version string. */
export const LastCheck = z.strictObject({
  at: z.string().regex(/^[0-9TZ:.+-]{10,40}$/),
  channel: z.enum(["stable", "next"]),
  current: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  latest: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/),
  status: z.enum(["newer", "current", "older"]),
});

/**
 * The background check (M6bR22): once 10 minutes after boot, then every 24 hours. It only logs and records; it never downloads
 * an archive and never applies anything, and nothing in it can throw into the daemon.
 */
export function startUpdateCheck(options: UpdateCheckOptions): { stop(): void } {
  const { clock, logger } = options;
  const stopped = new AbortController();
  let timer: TimerHandle | null = null;
  const skip =
    options.dev ||
    options.version === "0.0.0" ||
    !enabled(options.env, options.defaultOn ?? UPDATE_CHECK_DEFAULT);
  if (skip) return { stop: () => undefined };
  const channel = resolveChannel(undefined, options.env) ?? "stable";

  const schedule = (ms: number): void => {
    timer = clock.setTimeout(() => void run(), ms);
  };

  async function run(): Promise<void> {
    try {
      if (stopped.signal.aborted) return;
      schedule(INTERVAL_MS);
      const { status, feed } = await checkForUpdate({
        channel,
        current: options.version,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        signal: stopped.signal,
      });
      if (stopped.signal.aborted) return;
      if (status === "newer")
        logger.info("update_available", { current: options.version, latest: feed.version, channel });
      try {
        writeJsonAtomic(
          join(opsDir(options.home), "last-check.json"),
          LastCheck.parse({
            at: new Date(clock.now()).toISOString(),
            channel,
            current: options.version,
            latest: feed.version,
            status,
          }),
        );
      } catch {
        logger.debug("update_check_failed", { code: "state_write" });
      }
    } catch (error) {
      // a stop that arrives while a request is open is not a failure worth a line
      if (stopped.signal.aborted) return;
      try {
        logger.debug("update_check_failed", { code: failureCode(error) });
      } catch {
        // a logger that throws must not reach the daemon either
      }
    }
  }

  schedule(FIRST_RUN_MS);
  return {
    stop() {
      stopped.abort();
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
