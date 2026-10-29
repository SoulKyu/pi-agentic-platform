/** What the precache list needs to know of a bundle's output, read structurally (no direct dependency on Rolldown's types). */
export type BundleLike = Record<
  string,
  | {
      readonly type: "chunk";
      readonly fileName: string;
      readonly isEntry?: boolean;
      readonly moduleIds: readonly string[];
      readonly imports: readonly string[];
      readonly dynamicImports: readonly string[];
      readonly viteMetadata?: { readonly importedCss?: ReadonlySet<string> };
    }
  | { readonly type: "asset"; readonly fileName: string }
>;

/** The lazy modules of rich replies: each loads, with everything only it uses, the first time a reply holds math or a diagram. */
const ROOT_MODULES = /[\\/]packages[\\/]ui[\\/]src[\\/]ai[\\/]markdown[\\/](?:math|mermaid)\.ts$/u;
const KATEX_FONT = /^assets\/KaTeX_[^/]+\.woff2$/u;

/**
 * The output files that the service worker leaves out of its precache list: what the app cannot reach without loading
 * `math.ts` or `mermaid.ts`. Everything reachable from the entry chunks through static and dynamic imports, WITHOUT entering
 * those two chunks, stays precached (the rich side shares chunks with the app, and a shared chunk's own lazy imports are the
 * app's). The rest is KaTeX, Mermaid's core and its diagram types; their stylesheets are left out when only those chunks
 * import them, and so are KaTeX's fonts. They are most of the build, a PWA install must not download them, and the worker's
 * list is held to a gzip budget. The worker's fetch handler caches them the first time a reply needs them.
 */
export function richLazyAssets(bundle: BundleLike): Set<string> {
  const chunks = new Map(
    Object.values(bundle).flatMap((item) => (item.type === "chunk" ? [[item.fileName, item] as const] : [])),
  );
  const roots = new Set(
    [...chunks.values()]
      .filter((c) => c.moduleIds.some((id) => ROOT_MODULES.test(id)))
      .map((c) => c.fileName),
  );
  const kept = new Set<string>();
  const queue = [...chunks.values()].filter((c) => c.isEntry === true).map((c) => c.fileName);
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (kept.has(name) || roots.has(name)) continue;
    kept.add(name);
    const chunk = chunks.get(name);
    if (chunk) queue.push(...chunk.imports, ...chunk.dynamicImports);
  }
  const out = new Set<string>();
  // Without an entry there is nothing to measure against: leave nothing out but the fonts.
  if (kept.size > 0) for (const name of chunks.keys()) if (!kept.has(name)) out.add(name);
  const cssUsers = new Map<string, string[]>();
  for (const chunk of chunks.values())
    for (const css of chunk.viteMetadata?.importedCss ?? [])
      cssUsers.set(css, [...(cssUsers.get(css) ?? []), chunk.fileName]);
  for (const [css, users] of cssUsers) if (users.every((user) => out.has(user))) out.add(css);
  for (const name of Object.keys(bundle)) if (KATEX_FONT.test(name)) out.add(name);
  return out;
}
