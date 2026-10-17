import { isIP } from "node:net";
import { isHostName } from "../../../kernel/host-name.ts";

export interface HostRule {
  readonly exact?: string;
  readonly suffix?: string;
}

export const PUSH_SERVICE_HOSTS: readonly HostRule[] = [
  { suffix: ".push.apple.com" },
  { exact: "fcm.googleapis.com" },
  { suffix: ".push.services.mozilla.com" },
  { exact: "updates.push.services.mozilla.com" },
  { suffix: ".notify.windows.com" },
];

/** Built-ins plus the exact names of PAP_PUSH_EXTRA_HOSTS. There is no way to turn the list off (owner n1). */
export const hostRules = (extra: readonly string[]): readonly HostRule[] => [
  ...PUSH_SERVICE_HOSTS,
  ...extra.map((exact) => ({ exact })),
];

const hostAllowed = (host: string, rules: readonly HostRule[]): boolean =>
  rules.some(
    (r) =>
      (r.exact !== undefined && host === r.exact) ||
      (r.suffix !== undefined && host.endsWith(r.suffix) && host.length > r.suffix.length),
  );

export type EndpointRefusal =
  | "too_long"
  | "malformed"
  | "not_https"
  | "credentials"
  | "port"
  | "fragment"
  | "ip_literal"
  | "host"
  | "host_not_allowed";

export type EndpointCheck = { ok: true; href: string; host: string } | { ok: false; reason: EndpointRefusal };

const refuse = (reason: EndpointRefusal): EndpointCheck => ({ ok: false, reason });
const MAX_HREF = 2048;

export function endpointRefusal(
  raw: string,
  o: { hosts: readonly HostRule[]; loopbackForTests: boolean },
): EndpointCheck {
  if (raw.length > MAX_HREF) return refuse("too_long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("malformed");
  }
  if (url.href.length > MAX_HREF) return refuse("too_long"); // spaces and non-ASCII grow when canonicalised
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  // The test switch replaces the protocol check (and with it the port and the host list) for http://127.0.0.1 only.
  const loopback = o.loopbackForTests && url.protocol === "http:" && host === "127.0.0.1";
  if (!loopback && url.protocol !== "https:") return refuse("not_https");
  if (url.username !== "" || url.password !== "") return refuse("credentials");
  if (url.hash !== "" || raw.includes("#")) return refuse("fragment"); // an empty "#" leaves url.hash empty
  if (loopback) return { ok: true, href: url.href, host };
  if (url.port !== "") return refuse("port"); // WHATWG drops :443 for https, so any port left is not 443
  if (isIP(host) !== 0) return refuse("ip_literal");
  if (!isHostName(host)) return refuse("host");
  if (!hostAllowed(host, o.hosts)) return refuse("host_not_allowed");
  return { ok: true, href: url.href, host };
}
