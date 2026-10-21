import type { EgressHost, EgressReason } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { allowed, type EgressScope, normalizeHost } from "./allow.ts";
import { createLookup } from "./lookup.ts";
import { displayHost } from "./refusal.ts";

/** Why a VM's request was refused for its host list or address (sub-project 2, spec §3); the VM judge sets it. */
export interface VmDetail {
  readonly reason: "not_listed" | "private_wildcard" | "blocked_address";
  readonly address: string | null;
}

export type Decision =
  | { readonly ips: readonly string[]; readonly host: string }
  | {
      readonly reason: EgressReason;
      readonly host: string;
      /** The one-line body of the refusal, when the default sentence of `reason` is not the whole story (VM mode). */
      readonly message?: string;
      /** 502 for a failure that is not a refusal (a listed name that does not resolve); the default status follows `reason`. */
      readonly status?: 502;
      readonly vm?: VmDetail;
    };

export interface JudgeDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  resolve(host: string): Promise<readonly string[]>;
  denies(ip: string): boolean;
  readonly resolveMs: number;
}

/**
 * Decides what a target gets: normalize, port, allowlist, then resolve under the deadline and refuse when any answer is
 * blocked. The answer is the address the connection will use (no second lookup).
 */
export function createJudge(deps: JudgeDeps) {
  const { lookup, busyKeys } = createLookup(deps);

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

  return { decide, busyKeys };
}
