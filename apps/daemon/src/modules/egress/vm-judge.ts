import { isIP } from "node:net";
import { type BoxRef, type EgressHost, entryAllows, tryParseHostEntry } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { normalizeHost } from "./allow.ts";
import type { Decision, VmDetail } from "./proxy-core.ts";
import { createLookup } from "./lookup.ts";
import { displayHost } from "./refusal.ts";
import { canonicalAddress, type vmAddressRefused } from "../../kernel/net/vm-address.ts";

/** Who a VM's request is judged as: the launch behind its source address, and the box's host list now. */
export interface VmScope {
  readonly box: BoxRef;
  readonly launchId: string;
  readonly source: "thread" | { readonly task: string };
  readonly hosts: readonly string[];
  /** The box's trusted sources now: a CONNECT on 443 to one of them is the only allowed request that leaves content clean. */
  readonly trustedSources: readonly string[];
}

export interface VmRefusal {
  readonly box: BoxRef;
  readonly launchId: string;
  readonly source: VmScope["source"];
  readonly host: string;
  readonly port: number;
  readonly reason: VmDetail["reason"];
  readonly address: string | null;
}

export interface VmJudgeDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  resolve(host: string): Promise<readonly string[]>;
  readonly resolveMs: number;
  /** Only the composition passes `vmAddressRefused`; tests pass a seam from `testing/`. */
  readonly addressRefused: typeof vmAddressRefused;
  hostAddresses(): readonly string[];
}

type Target = { readonly host: string; readonly ip: boolean } | { readonly invalid: Decision };

function targetOf(rawHost: string): Target {
  const lower = rawHost.toLowerCase().replace(/\.$/, "");
  const bare = lower.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return { host: bare, ip: true };
  const parsed = normalizeHost(rawHost);
  return "reason" in parsed
    ? { invalid: { reason: parsed.reason, host: displayHost(rawHost) } }
    : { host: parsed.host, ip: false };
}

const SENTENCES: Record<VmDetail["reason"], string> = {
  not_listed: "is not on this agent's host list (not_listed). Ask the owner to add it.",
  private_wildcard:
    "resolves to a private address, which a wildcard entry never reaches (private_wildcard). List the exact name.",
  blocked_address: "resolves to an address pap never reaches (blocked_address).",
};

/**
 * Decides what an agent VM's target gets (spec §3): the host list (host, port, IP entries), then the address policy on
 * the answers. The addresses returned are the ones that were checked: the connection uses them and no other lookup.
 */
export function createVmJudge(deps: VmJudgeDeps) {
  const { lookup } = createLookup(deps);

  const refused = (
    host: string,
    port: number,
    reason: VmDetail["reason"],
    address: string | null,
  ): Decision => ({
    reason: reason === "not_listed" ? "not_listed" : "blocked_ip",
    host,
    message: `pap egress proxy: ${host}:${port} ${SENTENCES[reason]}`,
    vm: { reason, address },
  });

  /** A listed name that does not resolve is a failure, not a refusal: 502, so the client can tell it from a list refusal. */
  const unresolved = (host: string, port: number): Decision => ({
    reason: "dns_failed",
    host,
    status: 502,
    message: `pap egress proxy: ${host}:${port} could not be resolved (resolve).`,
  });

  async function decide(
    scope: VmScope,
    command: object,
    _kind: EgressHost["kind"],
    rawHost: string,
    port: number,
  ): Promise<Decision> {
    const target = targetOf(rawHost);
    if ("invalid" in target) {
      const { invalid } = target;
      return {
        ...invalid,
        message: `pap egress proxy: ${invalid.host}:${port} is not a valid host name or IP address.`,
      };
    }
    const { host } = target;
    const matching = scope.hosts
      .map(tryParseHostEntry)
      .filter((entry) => entry !== null)
      .filter((entry) =>
        target.ip
          ? entry.ip && canonicalAddress(entry.host) === canonicalAddress(host) && entry.ports.includes(port)
          : !entry.ip && entryAllows(entry, host, port),
      );
    if (matching.length === 0) return refused(host, port, "not_listed", null);
    const exact = matching.some((entry) => entry.ip || !entry.wildcard);
    let answers: readonly string[];
    if (target.ip) answers = [host];
    else {
      try {
        answers = await lookup([command, `vm:${scope.launchId}`], host);
      } catch {
        return unresolved(host, port);
      }
      if (answers.length === 0) return unresolved(host, port);
    }
    const own = deps.hostAddresses();
    const verdicts = answers.map((ip) => [ip, deps.addressRefused(ip, exact, own)] as const);
    const blocked =
      verdicts.find(([, why]) => why === "blocked_address") ?? verdicts.find(([, why]) => why !== null);
    if (blocked?.[1]) return refused(host, port, blocked[1], blocked[0]);
    return { ips: answers, host };
  }

  return { decide };
}
