const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/**
 * Model text is untrusted: only absolute http(s) and mailto links survive. A relative path (into pap), javascript:,
 * data: and anything the URL parser refuses render as plain text instead (the caller shows the link text).
 */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // not an absolute URL: shown as text, which is the documented outcome
  }
  return ALLOWED.has(url.protocol) ? url.href : null;
}
