import { createHash } from "node:crypto";
import { PapError, VCS_LIMITS, type VcsStatus } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { LineCounter } from "./line-counts.ts";
import { emptyStatus } from "./status.ts";

/** A cached status younger than this answers a subscription without a new run (M8R45). */
export const FRESH_MS = 2000;
/** The longest wait between two polls after timeouts (M8R45). */
export const MAX_POLL_MS = 5 * 60_000;
/** Roots that keep a cached status (M8R49). */
export const MAX_ROOTS = 32;

/** The stream key of the view a token gets: the status without what its boundary refuses (MC24). */
export const TOKEN_PREFIX = "token:";
export const tokenKey = (root: string): string => `${TOKEN_PREFIX}${root}`;

export interface PollerDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish" | "hasSubscribers">;
  /** The token's view of a status. */
  restrict(status: VcsStatus): VcsStatus;
  /** One counter per cached root; it goes with the root. */
  newCounter(root: string): LineCounter;
  /** One status run; `counter` is null when line counts are to be skipped. */
  read(root: string, counter: LineCounter | null): Promise<VcsStatus>;
}

export interface Poller {
  /** The cached status (the token view for a `token:` key), or null: the hub's snapshot is synchronous (M8R48). */
  snapshot(root: string): VcsStatus | null;
  /** A subscription: runs when the cached status is older than 2 s, else only makes sure the poll is armed. Throws `capacity`. */
  watch(root: string): void;
  /** `vcs.refresh`: runs now, or once more when a run is in flight. Throws `capacity`. */
  refresh(root: string): void;
  stop(): void;
}

interface Watch {
  readonly root: string;
  readonly counter: LineCounter;
  status: VcsStatus | null;
  /** Digest of the last published status minus `at`. */
  published: string | null;
  publishedToken: string | null;
  running: boolean;
  /** A trigger arrived during the run: exactly one more follows. */
  again: boolean;
  timer: TimerHandle | null;
  intervalMs: number;
  skipCounts: boolean;
}

const digestOf = (status: VcsStatus): string =>
  createHash("sha256")
    .update(JSON.stringify({ ...status, at: 0 }))
    .digest("hex");

export function createPoller(deps: PollerDeps): Poller {
  const { clock, hub } = deps;
  const watches = new Map<string, Watch>();
  const listened = (root: string): boolean =>
    hub.hasSubscribers("vcs", root) || hub.hasSubscribers("vcs", tokenKey(root));

  const dispose = (watch: Watch): void => {
    if (watch.timer) clock.clearTimeout(watch.timer);
    watch.timer = null;
    watches.delete(watch.root);
  };

  /** M8R49: the oldest root nobody watches makes room; a watched root is never evicted. */
  function admit(root: string): Watch {
    const existing = watches.get(root);
    if (existing) return existing;
    if (watches.size >= MAX_ROOTS) {
      const victim = [...watches.values()].find((watch) => !listened(watch.root));
      if (!victim) throw new PapError("capacity");
      dispose(victim);
    }
    const watch: Watch = {
      root,
      counter: deps.newCounter(root),
      status: null,
      published: null,
      publishedToken: null,
      running: false,
      again: false,
      timer: null,
      intervalMs: VCS_LIMITS.pollMs,
      skipCounts: false,
    };
    watches.set(root, watch);
    return watch;
  }

  /** The poll is armed only for a root somebody listens to, and never while a run is in flight (it re-arms at its end). */
  function arm(watch: Watch, early = false): void {
    if (watch.timer || watch.running || !(early || listened(watch.root))) return;
    watch.timer = clock.setTimeout(() => {
      watch.timer = null;
      if (watches.get(watch.root) === watch && listened(watch.root)) trigger(watch);
    }, watch.intervalMs);
  }

  function trigger(watch: Watch): void {
    if (watch.running) {
      watch.again = true;
      return;
    }
    run(watch).catch((error: unknown) => {
      deps.logger.error("vcs_run_failed", { err: error });
    });
  }

  async function run(watch: Watch): Promise<void> {
    watch.running = true;
    if (watch.timer) clock.clearTimeout(watch.timer);
    watch.timer = null;
    let next: VcsStatus;
    try {
      next = await deps.read(watch.root, watch.skipCounts ? null : watch.counter);
    } catch (error) {
      deps.logger.warn("vcs_read_failed", { err: error });
      next = emptyStatus(watch.root, clock.now(), true, "failed");
    }
    watch.running = false;
    // Dropped while it ran (capacity, stop): the result belongs to nobody.
    if (watches.get(watch.root) !== watch) return;
    watch.status = next;
    if (next.error === "timeout") {
      watch.skipCounts = true;
      watch.intervalMs = Math.min(watch.intervalMs * 2, MAX_POLL_MS);
    } else if (next.error === null) {
      watch.skipCounts = false;
      watch.intervalMs = VCS_LIMITS.pollMs;
    }
    const digest = digestOf(next);
    if (digest !== watch.published) {
      watch.published = digest;
      hub.publish("vcs", watch.root, { kind: "status", status: next });
    }
    if (hub.hasSubscribers("vcs", tokenKey(watch.root))) {
      const view = deps.restrict(next);
      const viewDigest = digestOf(view);
      if (viewDigest !== watch.publishedToken) {
        watch.publishedToken = viewDigest;
        hub.publish("vcs", tokenKey(watch.root), { kind: "status", status: view });
      }
    }
    if (watch.again) {
      watch.again = false;
      trigger(watch);
    } else arm(watch);
  }

  return {
    snapshot(key) {
      if (!key.startsWith(TOKEN_PREFIX)) return watches.get(key)?.status ?? null;
      const status = watches.get(key.slice(TOKEN_PREFIX.length))?.status;
      return status ? deps.restrict(status) : null;
    },
    watch(root) {
      const watch = admit(root);
      // A run in flight answers this subscription too.
      if (watch.running) return;
      const stale = watch.status === null || clock.now() - watch.status.at > FRESH_MS;
      if (stale) trigger(watch);
      // The handler opens the subscription right after this call, so the timer is armed before anybody is listed; its
      // callback looks again.
      else arm(watch, true);
    },
    refresh(root) {
      trigger(admit(root));
    },
    stop() {
      for (const watch of [...watches.values()]) dispose(watch);
    },
  };
}
