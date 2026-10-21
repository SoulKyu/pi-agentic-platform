import { z } from "zod";
import { HostPattern } from "./host-pattern.ts";

/** A host list entry of an agent in VM mode: `host`, `host:port`, an IPv4, `[ipv6]:port`, or `*.name` (spec §5, decision 119). */
export interface HostEntry {
  /** Lowercase, without the `*.` and without brackets. */
  readonly host: string;
  readonly ip: boolean;
  readonly wildcard: boolean;
  /** `[80, 443]` when the entry names no port. */
  readonly ports: readonly number[];
}
export const DEFAULT_ENTRY_PORTS: readonly number[] = Object.freeze([80, 443]);

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_CHARS = /^(?=.*:)[0-9a-f:.]{2,45}$/;
/** Brackets only when a port follows. */
const BRACKETED = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/;

/** contracts also runs in the browser: the WHATWG URL parser is the validator, not `node:net`. */
function isIpv6(host: string): boolean {
  if (!IPV6_CHARS.test(host)) return false;
  try {
    return new URL(`http://[${host}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

const portOf = (text: string | undefined): number | null | undefined => {
  if (text === undefined) return undefined;
  const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65_535 ? port : null;
};

function split(entry: string): { host: string; port: string | undefined; bracketed: boolean } | null {
  const bracketed = BRACKETED.exec(entry);
  if (bracketed) return { host: (bracketed[1] ?? "").toLowerCase(), port: bracketed[2], bracketed: true };
  const colons = entry.split(":");
  if (colons.length > 2) return { host: entry.toLowerCase(), port: undefined, bracketed: true }; // a bare IPv6, no port
  return { host: colons[0] ?? "", port: colons[1], bracketed: false };
}

/** null: not a valid entry. */
export function tryParseHostEntry(entry: string): HostEntry | null {
  if (entry.length > 260) return null;
  const parts = split(entry);
  if (!parts) return null;
  const port = portOf(parts.port);
  if (port === null) return null;
  const ports = port === undefined ? DEFAULT_ENTRY_PORTS : [port];
  if (parts.bracketed)
    return isIpv6(parts.host) ? { host: parts.host, ip: true, wildcard: false, ports } : null;
  if (IPV4.test(parts.host)) {
    const valid = parts.host
      .split(".")
      .every((octet) => Number(octet) <= 255 && String(Number(octet)) === octet);
    return valid ? { host: parts.host, ip: true, wildcard: false, ports } : null;
  }
  if (!HostPattern.safeParse(parts.host).success) return null;
  const wildcard = parts.host.startsWith("*.");
  return { host: wildcard ? parts.host.slice(2) : parts.host, ip: false, wildcard, ports };
}

/** Whether host mode refuses the entry: it names a port or an IP address, which only VM mode matches (decision 119). */
export function entryNeedsVm(entry: string): boolean {
  const parsed = tryParseHostEntry(entry);
  return parsed !== null && (parsed.ip || parsed.ports.length !== 2 || entry.includes(":"));
}

export function parseHostEntry(entry: string): HostEntry {
  const parsed = tryParseHostEntry(entry);
  if (!parsed) throw new Error("not a host entry");
  return parsed;
}

/** Whether the entry lets `host` (no brackets) at `port` through. A wildcard covers subdomains, not the apex. */
export function entryAllows(entry: HostEntry, host: string, port: number): boolean {
  if (!entry.ports.includes(port)) return false;
  const name = host.toLowerCase();
  return entry.wildcard ? name.endsWith(`.${entry.host}`) : name === entry.host;
}

export const AgentHostEntry = z
  .string()
  .refine((entry) => tryParseHostEntry(entry) !== null, "a host, host:port, IP or [IPv6]:port");

/** The list entry that lets `host` through at `port`: ports 80 and 443 are the bare host, an IPv6 literal with a port is bracketed. */
export function entryFor(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "");
  const name = bare.includes(":") ? `[${bare}]` : bare;
  return port === 80 || port === 443 ? bare : `${name}:${port}`;
}
