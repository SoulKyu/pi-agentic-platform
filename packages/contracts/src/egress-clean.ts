import type { EgressHost } from "./egress.ts";

/**
 * Whether one allowed request leaves a session's content clean: only a CONNECT on 443 to a trusted source. The worker's report
 * check and the daemon's proxy judge the same way, so a VM and a host command never disagree on it.
 */
export const cleansContent = (
  kind: EgressHost["kind"],
  port: number,
  host: string,
  trusted: readonly string[],
): boolean => kind === "connect" && port === 443 && trusted.includes(host);
