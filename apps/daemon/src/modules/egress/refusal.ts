import type { EgressReason } from "@pap/contracts";

export const UNREADABLE_HOST = "an unreadable host";

/** The target as it may be shown back (and recorded): plain host characters, else a fixed phrase. Never raw bytes. */
export const displayHost = (raw: string): string =>
  /^[a-z0-9._[\]:-]{1,253}$/i.test(raw) ? raw.toLowerCase() : UNREADABLE_HOST;

const SENTENCES: Record<Exclude<EgressReason, "not_listed">, (host: string) => string> = {
  port: () => "only ports 80 and 443 are open.",
  ip_literal: () => "IP addresses are not allowed; use a host name.",
  bad_target: (host) => `${host} is not a valid host name.`,
  blocked_ip: (host) => `${host} resolves to a private or reserved address.`,
  dns_failed: (host) => `${host} could not be resolved.`,
  bad_request: () => "only absolute http:// URLs and CONNECT host:443 are accepted.",
  scheme: () => "only http:// URLs are proxied; use CONNECT host:443 for https.",
  limit: () => "too many connections.",
};

/** The fixed body of a plain HTTP refusal (M11R238): the hint to ask the owner is only for a host off the list. */
export const refusalBody = (reason: EgressReason, host: string): string =>
  reason === "not_listed"
    ? `pap egress proxy: ${host} is not on this agent's host list. In the agent's thread, ask the owner with network_request {"host": "${host}"}.\n`
    : `pap egress proxy: ${SENTENCES[reason](host)}\n`;

export const refusalStatus = (reason: EgressReason): 400 | 403 | 503 =>
  reason === "bad_request" ? 400 : reason === "limit" ? 503 : 403;

const TEXT = {
  400: "Bad Request",
  403: "Forbidden",
  502: "Bad Gateway",
  503: "Service Unavailable",
} as const;

/** A refusal written straight on a socket: a CONNECT answer, or a connection refused before its head is read. A `message` becomes its one-line body. */
export const rawRefusal = (reason: EgressReason, message?: string, override?: 502): string => {
  const status = override ?? refusalStatus(reason);
  const head = `HTTP/1.1 ${status} ${TEXT[status]}\r\nx-pap-deny: ${reason}\r\nconnection: close\r\n`;
  if (message === undefined) return `${head}\r\n`;
  const body = `${message}\n`;
  return `${head}content-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

export const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n";
export const HEAD_TOO_LARGE = "HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\n\r\n";
export const BAD_HEAD = "HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n";
