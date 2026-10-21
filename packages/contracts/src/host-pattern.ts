import { z } from "zod";

/**
 * A host the egress stage lets through (Task 5a): lower-case labels of letters, digits and inner hyphens, at least two
 * labels, or `*.` and such a host (subdomains only). No IP literal, port, path or bare TLD: an IP or `localhost` is
 * refused here because a host list is a list of names; Task 5a refuses IP-literal URLs that no entry names.
 */
const LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
/**
 * A last label that starts with a digit: no top-level domain does, so the host is an IP literal in some spelling
 * (`127.1`, `127.0x1`, `2130706433`). The egress proxy refuses it as `ip_literal`; a host list refuses it too.
 */
export const lastLabelStartsWithDigit = (host: string): boolean =>
  /\d/.test(host.split(".").at(-1)?.[0] ?? "");
export const HostPattern = z
  .string()
  .max(253)
  .regex(new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`))
  .refine((host) => !lastLabelStartsWithDigit(host), "an IP address is not a host name");
