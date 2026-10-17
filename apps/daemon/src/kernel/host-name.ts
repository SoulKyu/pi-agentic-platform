import { isIP } from "node:net";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The last label starts with a letter: no all-digit or `0x7f` last label, so no IPv4 spelling passes as a name.
const TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A lower-case LDH (letters, digits, hyphen) host name with at least two labels: no IP address in any spelling, no empty
 * label, no trailing dot. The one rule for `PAP_PUSH_EXTRA_HOSTS` (config) and for a stored push endpoint.
 */
export function isHostName(host: string): boolean {
  if (host.length === 0 || host.length > 253 || isIP(host) !== 0) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label, index) => (index === labels.length - 1 ? TLD : LABEL).test(label));
}
