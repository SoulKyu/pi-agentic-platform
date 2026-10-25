import { type BoxRef, boxKey, type RelayCommand, RelayReport } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LaunchGrant } from "./runtime.ts";

/** The restart delays (RT-36): 1 s, doubling, 30 s at most; a child that was ready for a minute is not a crash loop. */
export const RELAY_RESTART_MIN_MS = 1000;
export const RELAY_RESTART_MAX_MS = 30_000;
export const RELAY_STABLE_MS = 60_000;
/** RT-17: more relay requests than the turns the workers reported, by this many, in one window is logged as a mismatch. */
export const RELAY_MISMATCH_MARGIN = 10;

/** What the daemon asks of the relay child (`child_process.fork` in production, a fake in the unit tests). */
export interface RelayChild {
  /** The child's pid (a real fork has one): the listener check asks which sockets are its own. */
  readonly pid?: number | undefined;
  send(message: unknown): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** What a box may ask of its relay (R13): the models its picker offers, the bridge, and whether it may ask now. */
export interface PolicyView {
  readonly models: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
  readonly claude: boolean;
  /** The Claude token of the box's owner (M14), or null: the relay serves the bridge with it and answers `no_claude_token` without. Never logged. */
  readonly claudeToken: string | null;
  readonly blocked: "paused" | "budget" | null;
}

export interface RelayLinkDeps {
  /** Starts a `pap-relay` child. Called again after each exit. */
  fork(): RelayChild;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Resolves once the address the relay binds exists (pap0 in vm mode); the process backend's is loopback. */
  bridgeReady?(): Promise<void>;
  /**
   * AVM-E49 M9b, run when a child reports ready (so after every restart): null when the sockets listening on the gateway and relay
   * addresses are pap's own, else the reason. A reason makes the child not ready (launches stay refused) and it is restarted.
   */
  listenerFault?(child: RelayChild): string | null;
  /** The box's allowed models and state now; a rejection makes the box use nothing until the next push (fail closed). */
  policyOf(box: BoxRef): Promise<PolicyView>;
  /** The turns (assistant messages) the box's workers reported in the window just ended (RT-17): each is one provider request. */
  reportedTurns?(box: BoxRef): number;
  /** A relay report was handled: the window's counts start again. */
  windowEnded?(): void;
}

export interface RelayLink {
  /** Waits for the bridge, then starts the child. Idempotent. */
  start(): Promise<void>;
  grant(grant: LaunchGrant): void;
  revoke(launchId: string): void;
  /** The box's policy changed (models, pause, budget): pushed when the box has a live launch. */
  refresh(box: BoxRef): void;
  refreshAll(): void;
  /** Resolves when a child is ready to serve (it listens), or when `signal` aborts (the waiter is then removed, N6). */
  whenReady(signal?: AbortSignal): Promise<void>;
  /** How many callers wait for ready (a test aid: a given-up wait must not stay). */
  pendingWaiters(): number;
  /** The port the ready child listens on (an ephemeral one under the process backend), or null while none is ready. */
  port(): number | null;
  stop(): void;
}

const NOTHING: PolicyView = { models: [], claude: false, claudeToken: null, blocked: null };

/**
 * The daemon's half of the provider relay (R13, T12): forks `pap-relay`, restarts it with backoff and replays what it forgot
 * (every live grant, each live box's policy, the Claude token) when the new child is ready. Grants go out at a launch's
 * start and revokes at its end; the policy goes out at each grant and whenever the caller says the box's state changed.
 * Nothing it logs holds a relay key, a Claude token or a provider key: grants are sent, never logged.
 */
export function createRelayLink(deps: RelayLinkDeps): RelayLink {
  const { clock, logger } = deps;
  const grants = new Map<string, LaunchGrant>();
  const seq = new Map<string, number>();
  let child: RelayChild | null = null;
  let ready = false;
  let readyAt: number | null = null;
  let port: number | null = null;
  let delay = RELAY_RESTART_MIN_MS;
  let timer: TimerHandle | undefined;
  let started: Promise<void> | undefined;
  let stopped = false;
  let dropped = 0;
  let readyWaiters: Array<() => void> = [];

  const liveBoxes = (): Map<string, BoxRef> =>
    new Map([...grants.values()].map((grant) => [boxKey(grant.box), grant.box]));
  const send = (command: RelayCommand): boolean => {
    if (child === null || !ready) return false;
    try {
      return child.send(command);
    } catch {
      logger.warn("relay_send_failed", { type: command.type });
      return false;
    }
  };
  const sendGrant = (grant: LaunchGrant): void => {
    send({
      type: "relay_grant",
      launchId: grant.launchId,
      box: grant.box,
      key: grant.relayKey,
      address: grant.address as Extract<RelayCommand, { type: "relay_grant" }>["address"],
    });
  };

  async function pushPolicy(box: BoxRef): Promise<void> {
    const key = boxKey(box);
    if (!liveBoxes().has(key)) return;
    const mine = (seq.get(key) ?? 0) + 1;
    seq.set(key, mine);
    let view: PolicyView;
    try {
      view = await deps.policyOf(box);
    } catch (error) {
      logger.warn("relay_policy_failed", { box: key, err: error });
      view = NOTHING;
    }
    // A newer push started meanwhile, or the box has no launch left: this answer is stale.
    if (seq.get(key) !== mine || !liveBoxes().has(key)) return;
    send({
      type: "box_policy",
      box,
      models: [...view.models],
      claude: view.claude,
      claudeToken: view.claudeToken,
      blocked: view.blocked,
    });
  }

  function replay(): void {
    for (const grant of grants.values()) sendGrant(grant);
    for (const box of liveBoxes().values()) void pushPolicy(box);
  }

  function onReport(raw: unknown): void {
    const report = RelayReport.safeParse(raw);
    if (!report.success) {
      dropped++;
      // Powers of two: a child that floods garbage cannot flood the log; nothing of the message is kept.
      if ((dropped & (dropped - 1)) === 0) logger.warn("relay_report_dropped", { dropped });
      return;
    }
    if (report.data.type === "relay_ready") {
      const fault = child === null ? null : (deps.listenerFault?.(child) ?? null);
      if (fault !== null) {
        logger.error("relay_listener_foreign", { reason: fault });
        ready = false;
        port = null;
        child?.kill("SIGTERM");
        return;
      }
      ready = true;
      port = report.data.port;
      readyAt = clock.now();
      logger.info("relay_ready", { port: report.data.port });
      replay();
      const waiting = readyWaiters;
      readyWaiters = [];
      for (const resolve of waiting) resolve();
      return;
    }
    for (const usage of report.data.boxes) {
      logger.info("agent_relay_usage", { ...usage, box: boxKey(usage.box) });
      // A project box reports no turns (its sessions are not agents'): there is nothing to compare its requests with.
      if (usage.box.kind === "project") continue;
      const turns = deps.reportedTurns?.(usage.box) ?? 0;
      if (deps.reportedTurns && usage.requests - turns > RELAY_MISMATCH_MARGIN)
        logger.warn("agent_relay_mismatch", { box: boxKey(usage.box), requests: usage.requests, turns });
    }
    deps.windowEnded?.();
  }

  function fork(): void {
    timer = undefined;
    if (stopped) return;
    let mine: RelayChild;
    try {
      mine = deps.fork();
    } catch (error) {
      logger.error("relay_fork_failed", { err: error });
      scheduleRestart();
      return;
    }
    child = mine;
    ready = false;
    readyAt = null;
    let gone = false;
    const onGone = (): void => {
      if (gone) return;
      gone = true;
      if (child === mine) {
        child = null;
        ready = false;
        port = null;
      }
      if (!stopped) scheduleRestart();
    };
    mine.on("message", (message) => {
      if (child === mine) onReport(message);
    });
    mine.on("exit", onGone);
    mine.on("error", (error) => {
      logger.warn("relay_child_error", { err: error });
      onGone();
    });
  }

  /** The wait before the next start, then the delay doubles (1 s, 2 s ... 30 s); a child that stayed up resets it. */
  function scheduleRestart(): void {
    if (readyAt !== null && clock.now() - readyAt >= RELAY_STABLE_MS) delay = RELAY_RESTART_MIN_MS;
    readyAt = null;
    const wait = delay;
    delay = Math.min(delay * 2, RELAY_RESTART_MAX_MS);
    logger.warn("relay_restart", { inMs: wait });
    timer = clock.setTimeout(fork, wait);
  }

  return {
    start() {
      started ??= (async () => {
        await deps.bridgeReady?.();
        if (!stopped && child === null && timer === undefined) fork();
      })();
      return started;
    },
    grant(grant) {
      grants.set(grant.launchId, grant);
      sendGrant(grant);
      void pushPolicy(grant.box);
    },
    revoke(launchId) {
      const grant = grants.get(launchId);
      if (grant === undefined) return;
      grants.delete(launchId);
      send({ type: "relay_revoke", launchId });
      const key = boxKey(grant.box);
      if (liveBoxes().has(key)) return;
      // The box's last launch is over: the relay keeps nothing it could allow at the next launch before a fresh policy
      // arrives, and an answer still in flight is stale (the counter only grows).
      seq.set(key, (seq.get(key) ?? 0) + 1);
      send({
        type: "box_policy",
        box: grant.box,
        models: [],
        claude: false,
        claudeToken: null,
        blocked: null,
      });
    },
    refresh: (box) => void pushPolicy(box),
    refreshAll() {
      for (const box of liveBoxes().values()) void pushPolicy(box);
    },
    port: () => port,
    whenReady: (signal) =>
      ready || signal?.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            readyWaiters.push(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                readyWaiters = readyWaiters.filter((waiter) => waiter !== resolve);
                resolve();
              },
              { once: true },
            );
          }),
    pendingWaiters: () => readyWaiters.length,
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      const stopping = child;
      child = null;
      ready = false;
      port = null;
      stopping?.kill("SIGTERM");
      for (const resolve of readyWaiters.splice(0)) resolve();
    },
  };
}
