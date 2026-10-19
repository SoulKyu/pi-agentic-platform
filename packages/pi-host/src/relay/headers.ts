import type { ApiKind } from "./routes.ts";

/** What a VM's request may carry upstream: everything else (its relay key included) stops here. */
const FORWARDED = new Set([
  "content-type",
  "accept",
  "accept-encoding",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "user-agent",
]);
/** A provider's own headers never set these: the relay and Node own framing, routing and cookies. */
const RESERVED = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "proxy-authorization",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "x-forwarded-for",
]);
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;

/** What `resolveProvider` returns for the credential: the key and the provider's literal headers (models.json, host side). */
export interface UpstreamCredential {
  readonly value: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The headers the relay sends upstream (RT-18): an allowlist of the VM's, then the provider's literal headers, then the
 * credential in the header the api's SDK uses (`authorization: Bearer` for OpenAI and for the bridge). A provider header
 * of the same name wins over the default (an owner's custom auth header); it never sets a framing or routing header.
 * A null-prototype record: no incoming name reaches `Object.prototype`.
 */
export function upstreamHeaders(
  api: ApiKind | "claude",
  incoming: Readonly<Record<string, string | string[] | undefined>>,
  credential: UpstreamCredential,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if ((FORWARDED.has(lower) || lower.startsWith("x-stainless-")) && typeof value === "string")
      out[lower] = value;
  }
  if (api === "anthropic-messages") out["x-api-key"] = credential.value;
  else if (api === "google-generative-ai") out["x-goog-api-key"] = credential.value;
  else out.authorization = `Bearer ${credential.value}`;
  for (const [name, value] of Object.entries(credential.headers)) {
    const lower = name.toLowerCase();
    if (RESERVED.has(lower) || !HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) continue;
    out[lower] = value;
  }
  return out;
}
