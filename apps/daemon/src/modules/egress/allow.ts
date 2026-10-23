import { isIP } from "node:net";
import { type EgressReason, lastLabelStartsWithDigit } from "@pap/contracts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A target host as the proxy judges it: lower-cased, one final dot dropped, ASCII labels only (IDNs arrive as `xn--`),
 * at least two labels. An IP literal in any spelling (a last label starting with a digit, as `127.1`, `127.0x1` or `2130706433`: no top-level domain does) is
 * its own reason.
 */
export function normalizeHost(raw: string): { host: string } | { reason: EgressReason } {
  const lower = raw.toLowerCase().replace(/\.$/, "");
  const bare = lower.replace(/^\[|\]$/g, "");
  const labels = lower.split(".");
  if (isIP(bare) !== 0 || lastLabelStartsWithDigit(lower)) return { reason: "ip_literal" };
  if (lower.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { reason: "bad_target" };
  }
  return { host: lower };
}
