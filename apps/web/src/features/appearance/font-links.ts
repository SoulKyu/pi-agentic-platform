const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One same-origin stylesheet link per family in use (`/fonts/<slug>/font.css`, written by pap, `font-src 'self'`).
 * A link is added once and removed when its family is no longer chosen. Other links are never touched.
 */
export function syncFontLinks(doc: Document, slugs: readonly string[]): void {
  const wanted = new Set(slugs.filter((slug) => SLUG.test(slug)));
  const present = new Set<string>();
  for (const link of doc.head.querySelectorAll<HTMLLinkElement>("link[data-pap-font]")) {
    const slug = link.getAttribute("data-pap-font") ?? "";
    if (wanted.has(slug) && !present.has(slug)) present.add(slug);
    else link.remove();
  }
  for (const slug of wanted) {
    if (present.has(slug)) continue;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.setAttribute("href", `/fonts/${slug}/font.css`);
    link.setAttribute("data-pap-font", slug);
    doc.head.append(link);
  }
}
