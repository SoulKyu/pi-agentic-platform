/** A capability token of the untrusted origin (spec §4): 32 random bytes in base64url without padding. */
export const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The longest request target the listener reads; a longer one is a bare 404. */
export const MAX_TARGET_CHARS = 8192;

export type PreviewTarget =
  | {
      readonly kind: "service" | "artifact";
      readonly token: string;
      readonly prefix: string;
      readonly rest: string;
    }
  | {
      readonly kind: "slash";
      readonly of: "service" | "artifact";
      readonly token: string;
      readonly location: string;
    };

// Controls, space, DEL, a backslash and a fragment never belong in a request target the browser sends.
const REFUSED_CHARS = /[\0-\x20\x7f\\#]/;
const SHAPE = /^\/([pa])\/([^/?]*)(\/[^?]*)?(\?.*)?$/;

/**
 * The request target of the untrusted listener: `/p/<token>/<rest>` for a service, `/a/<token>/<rest>` for an artifact.
 * `rest` keeps its query and its percent-encoding byte for byte (the service parses it, never pap). `/p/<token>` with no
 * slash after it is `slash`: the listener answers a redirect to `/p/<token>/` so relative links resolve under the prefix.
 * A double slash after the token (`/p/<token>//x`) is the service's own path `//x`. The token is matched raw: an encoded token is not a token. Anything else (absolute or authority form, `*`, another
 * prefix, `//p/...`, a refused character, a target over 8 KiB) is null, which the listener answers with a bare 404.
 */
export function parsePreviewTarget(raw: string | undefined): PreviewTarget | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_TARGET_CHARS) return null;
  if (REFUSED_CHARS.test(raw)) return null;
  const match = SHAPE.exec(raw);
  if (match === null) return null;
  const [, letter, token = "", path, query = ""] = match;
  if (!PREVIEW_TOKEN.test(token)) return null;
  const prefix = `/${letter}/${token}`;
  const kind = letter === "p" ? "service" : "artifact";
  if (path === undefined) return { kind: "slash", of: kind, token, location: `${prefix}/${query}` };
  return { kind, token, prefix, rest: `${path}${query}` };
}
