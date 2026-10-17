export const PROVIDER_FORM_LIMITS = { models: 500, headers: 8, url: 2048, name: 128 } as const;

/** Hidden characters: controls (`Cc`), format characters (`Cf`: soft hyphen, zero-width, bidi, BOM), the whole range U+2060-206F (U+2065 is unassigned, so `Cf` misses it), line and paragraph separators, NBSP, and the tag range U+E0000-E007F. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u2060-\u206f\u{e0000}-\u{e007f}]/u;
/** One line of text with no hidden character (see `HIDDEN`). */
export function plainLine(text: string): boolean {
  return !HIDDEN.test(text);
}

export type BaseUrlRefusal =
  "too_long" | "control" | "not_a_url" | "scheme" | "credentials" | "query_or_fragment" | "host";
export type BaseUrlCheck =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: BaseUrlRefusal };

/** Where a plain `http:` base URL may point. */
export type HttpPlaintextPolicy = "loopback" | "any";
/**
 * THE owner policy for plain `http:` (owner q4, MPR9). `"loopback"`: this machine only. `"any"`: every host, and the
 * form warns when a key travels in clear (`keyTravelsInClear`). Flipping it is this one line plus the copy in the
 * settings-providers catalog; `BASE_URL_TABLE` already holds both columns, so its tests stay green either way.
 */
export const HTTP_PLAINTEXT_POLICY: HttpPlaintextPolicy = "loopback";

/** WHATWG normalises `0x7f.1` and `2130706433` to dotted quads, so the regex sees the real address. */
const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * `https:` to any host; `http:` as `policy` says. No credentials, query or fragment ever. The result is the origin
 * plus the path without a trailing slash (Pi appends its own paths). A host only spelled like a loopback
 * (`localhost.evil.com`, `127.0.0.1.evil.com`) is another host.
 */
export function checkBaseUrl(raw: string, policy: HttpPlaintextPolicy = HTTP_PLAINTEXT_POLICY): BaseUrlCheck {
  const fail = (reason: BaseUrlRefusal): BaseUrlCheck => ({ ok: false, reason });
  if (raw.length > PROVIDER_FORM_LIMITS.url) return fail("too_long");
  if (!plainLine(raw) || /\s/.test(raw)) return fail("control");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("not_a_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("scheme");
  if (url.username !== "" || url.password !== "") return fail("credentials");
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#"))
    return fail("query_or_fragment");
  if (url.protocol === "http:" && policy === "loopback" && !isLoopback(url.hostname)) return fail("host");
  const normalised = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  // The saved form is what reopens: it must pass the same limit.
  if (normalised.length > PROVIDER_FORM_LIMITS.url) return fail("too_long");
  return { ok: true, url: normalised };
}

/**
 * True when `baseUrl` is plain `http:` to a non-loopback host and something secret would travel in clear.
 * `carriesSecret`: the auth is stored or an env var, or any header is given as an env var (a secret header counts).
 */
export function keyTravelsInClear(baseUrl: string, carriesSecret: boolean): boolean {
  if (!carriesSecret) return false;
  const checked = checkBaseUrl(baseUrl, "any");
  if (!checked.ok) return false;
  const url = new URL(checked.url);
  return url.protocol === "http:" && !isLoopback(url.hostname);
}
