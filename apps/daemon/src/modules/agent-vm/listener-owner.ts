import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { AGENT_NET } from "@pap/contracts";

/**
 * AVM-E49 M9b: 10.213.0.1:7841 and :7842 are unprivileged ports and the firewall filters by interface, not by the receiving
 * socket. So the daemon checks that the sockets listening there belong to pap's own processes: the gateway to the daemon, the
 * relay to its child. What it reads is `/proc/net/tcp` and `tcp6` (the LISTEN rows) and `/proc/<pid>/fd` (the socket inodes of a process).
 */
export interface ProcReader {
  /** `/proc/net/tcp`. */
  tcp(): string;
  /** `/proc/net/tcp6` ("" or absent on a host without IPv6): a dual-stack socket on the port is listed there only. */
  tcp6?(): string;
  /** The targets of `/proc/<pid>/fd/*` (`socket:[123]`); empty when the process is gone or unreadable. */
  fdTargets(pid: number): readonly string[];
  /** The numeric entries of `/proc`. */
  pids(): readonly number[];
  /** The parent of `pid`, or null. */
  parentOf(pid: number): number | null;
}

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

interface Listener {
  readonly host: string;
  readonly port: number;
  readonly inode: number;
}

const WILDCARD = "0.0.0.0";

function dotted(hex: string): string {
  // /proc/net/tcp prints the address as a little-endian 32-bit word.
  const bytes = hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
  return bytes.length === 4 ? bytes.reverse().join(".") : "";
}

/** A `/proc/net/tcp6` address: the wildcard, or a v4-mapped one as its dotted form; any other v6 address is "" (no pap endpoint). */
function dotted6(hex: string): string {
  if (/^0{32}$/.test(hex)) return WILDCARD;
  const mapped = /^0{16}FFFF0000([0-9A-F]{8})$/i.exec(hex);
  return mapped?.[1] === undefined ? "" : dotted(mapped[1]);
}

/** The LISTEN rows of `/proc/net/tcp` (`v6`: of `/proc/net/tcp6`). */
export function parseListeners(text: string, v6 = false): Listener[] {
  const found: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const local = columns[1]?.split(":");
    if (columns[3] !== "0A" || local?.length !== 2) continue;
    const inode = Number(columns[9]);
    if (!Number.isSafeInteger(inode)) continue;
    found.push({ host: (v6 ? dotted6 : dotted)(local[0] ?? ""), port: parseInt(local[1] ?? "", 16), inode });
  }
  return found;
}

/** The inodes of the sockets in a list of fd targets. */
export function socketInodes(targets: readonly string[]): Set<number> {
  const inodes = new Set<number>();
  for (const target of targets) {
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match?.[1] !== undefined) inodes.add(Number(match[1]));
  }
  return inodes;
}

/** The sockets that listen where `endpoint` is served: its own address, or a wildcard on its port. */
function listenersAt(proc: ProcReader, endpoint: Endpoint): Listener[] {
  return [...parseListeners(proc.tcp()), ...parseListeners(proc.tcp6?.() ?? "", true)].filter(
    (one) => one.port === endpoint.port && (one.host === endpoint.host || one.host === WILDCARD),
  );
}

export type OwnerVerdict = { readonly owned: true } | { readonly owned: false; readonly reason: string };

/**
 * True when something listens at `endpoint` and every such socket is one of `pid`'s own. No listener, a socket of another
 * process or one nobody can be asked about (it is not in `pid`'s fd table) is not owned.
 */
export function ownsListener(proc: ProcReader, pid: number, endpoint: Endpoint): OwnerVerdict {
  const listening = listenersAt(proc, endpoint);
  if (listening.length === 0) return { owned: false, reason: "no socket listens there" };
  const mine = socketInodes(proc.fdTargets(pid));
  return listening.every((one) => mine.has(one.inode))
    ? { owned: true }
    : { owned: false, reason: "a socket that is not the process's own listens there" };
}

/** The pid whose fd table holds the (single) listening socket at `endpoint`; null when none listens or nobody visible holds it. */
export function ownerOf(proc: ProcReader, endpoint: Endpoint): { listening: boolean; pid: number | null } {
  const listening = listenersAt(proc, endpoint);
  if (listening.length === 0) return { listening: false, pid: null };
  const wanted = new Set(listening.map((one) => one.inode));
  for (const pid of proc.pids()) {
    const mine = socketInodes(proc.fdTargets(pid));
    if ([...wanted].some((inode) => mine.has(inode))) return { listening: true, pid };
  }
  return { listening: true, pid: null };
}

export function realProcReader(): ProcReader {
  return {
    tcp: () => readFileSync("/proc/net/tcp", "utf8"),
    tcp6() {
      try {
        return readFileSync("/proc/net/tcp6", "utf8");
      } catch {
        return ""; // no IPv6 on this host
      }
    },
    fdTargets(pid) {
      try {
        return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
          try {
            return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
    pids: () => readdirSync("/proc").flatMap((name) => (/^\d+$/.test(name) ? [Number(name)] : [])),
    parentOf(pid) {
      try {
        // `pid (comm) S ppid ...`: comm may hold spaces and parentheses, so cut after the last ")".
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return Number.isSafeInteger(ppid) ? ppid : null;
      } catch {
        return null;
      }
    },
  };
}

/** The bridge's endpoints: the gateway and the proxy (the daemon's) and the relay (its child's). */
export const GATEWAY_ENDPOINT: Endpoint = { host: AGENT_NET.host, port: AGENT_NET.gatewayPort };
export const RELAY_ENDPOINT: Endpoint = { host: AGENT_NET.host, port: AGENT_NET.relayPort };
/** The egress proxy for the VMs (the daemon's, like the gateway). */
export const PROXY_ENDPOINT: Endpoint = { host: AGENT_NET.host, port: AGENT_NET.proxyPort };

/** Null when both sockets are pap's own (the gateway the daemon's, the relay its child's), else what is wrong. */
export function bridgeListenerFault(
  proc: ProcReader,
  daemonPid: number,
  relayPid: number | undefined,
): string | null {
  try {
    const gateway = ownsListener(proc, daemonPid, GATEWAY_ENDPOINT);
    if (!gateway.owned) return `gateway ${GATEWAY_ENDPOINT.host}:${GATEWAY_ENDPOINT.port}: ${gateway.reason}`;
    if (relayPid === undefined) return "the relay child has no pid";
    const relay = ownsListener(proc, relayPid, RELAY_ENDPOINT);
    return relay.owned ? null : `relay ${RELAY_ENDPOINT.host}:${RELAY_ENDPOINT.port}: ${relay.reason}`;
  } catch {
    // Fail closed: a /proc that cannot be read is a relay that is not ready, never an uncaught throw in a message handler.
    return "the listening sockets could not be read from /proc";
  }
}
