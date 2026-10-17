import type { EgressHost, EgressReason } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { allowed, type EgressScope, normalizeHost } from "./allow.ts";
import { displayHost } from "./refusal.ts";

export type Decision =
  | { readonly ips: readonly string[]; readonly host: string }
  | { readonly reason: EgressReason; readonly host: string };

/** DNS lookups in flight daemon-wide, per command (W5-R43) and per session or agent: a sandbox can never fill libuv's threadpool. */
const LOOKUPS_TOTAL = 2;
const LOOKUPS_PER_KEY = 1;

export interface JudgeDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  resolve(host: string): Promise<readonly string[]>;
  denies(ip: string): boolean;
  readonly resolveMs: number;
}

interface Queued {
  /** What the lookup is counted against: its command, and its session (an agent's own folder for a precheck). */
  readonly keys: readonly [object, string];
  start(): void;
}

/**
 * Decides what a target gets: normalize, port, allowlist, then resolve under the deadline and refuse when any answer is
 * blocked. The answer is the address the connection will use (no second lookup).
 */
export function createJudge(deps: JudgeDeps) {
  const queue: Queued[] = [];
  const busy = new Map<object | string, number>();
  let running = 0;

  const pump = (): void => {
    for (let i = 0; i < queue.length && running < LOOKUPS_TOTAL;) {
      const next = queue[i] as Queued;
      if (next.keys.some((key) => (busy.get(key) ?? 0) >= LOOKUPS_PER_KEY)) i += 1;
      else {
        queue.splice(i, 1);
        next.start();
      }
    }
  };

  const take = (key: object | string): void => void busy.set(key, (busy.get(key) ?? 0) + 1);
  const give = (key: object | string): void => {
    const left = (busy.get(key) ?? 1) - 1;
    if (left <= 0) busy.delete(key);
    else busy.set(key, left);
  };

  /** Queued under the same deadline as the lookup itself: a lookup that never got a slot never starts. */
  function lookup(keys: readonly [object, string], host: string): Promise<readonly string[]> {
    return new Promise((resolve, reject) => {
      const timer = deps.clock.setTimeout(
        () =>
          void guardTimer(deps.logger, "egress_resolve", () => {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
            reject(new Error("resolve timeout"));
          }),
        deps.resolveMs,
      );
      const entry: Queued = {
        keys,
        start() {
          running += 1;
          keys.forEach(take);
          let work: Promise<readonly string[]>;
          try {
            work = deps.resolve(host);
          } catch (error) {
            work = Promise.reject(error instanceof Error ? error : new Error("lookup failed"));
          }
          void work.then(resolve, reject).finally(() => {
            deps.clock.clearTimeout(timer);
            running -= 1;
            keys.forEach(give);
            pump();
          });
        },
      };
      queue.push(entry);
      pump();
    });
  }

  async function decide(
    scope: EgressScope,
    command: object,
    kind: EgressHost["kind"],
    rawHost: string,
    port: number,
  ): Promise<Decision> {
    const parsed = normalizeHost(rawHost);
    if ("reason" in parsed) return { reason: parsed.reason, host: displayHost(rawHost) };
    const host = parsed.host;
    if (port !== (kind === "connect" ? 443 : 80)) return { reason: "port", host };
    if (!allowed(scope, host)) return { reason: "not_listed", host };
    let answers: readonly string[];
    try {
      answers = await lookup([command, scope.sessionId ?? `pre:${scope.agentId}`], host);
    } catch {
      return { reason: "dns_failed", host };
    }
    if (answers.length === 0) return { reason: "dns_failed", host };
    if (answers.some((ip) => deps.denies(ip))) return { reason: "blocked_ip", host };
    return { ips: answers, host };
  }

  return {
    decide,
    /** How many commands or sessions have a lookup in flight: back to 0 when idle (the map keeps no dead entry). */
    busyKeys: (): number => busy.size,
  };
}
