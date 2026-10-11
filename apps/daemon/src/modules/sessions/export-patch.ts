import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Logger } from "../../kernel/logger.ts";

interface ExportPatch {
  readonly name: string;
  readonly anchor: RegExp;
  readonly replacement: string;
}

/** A transcript of a very long session can be tens of megabytes; past this the file is served as Pi wrote it. */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024;

/**
 * The recursive helpers of Pi 1.1.0's export template, which overflow the browser's stack on a session of a few
 * thousand entries in a line, and the loops that take their place. The replacements are pap's own code; the anchors are
 * Pi's text, matched with any whitespace. A replacement holds no markup, no handler and no resource of its own.
 */
export const EXPORT_PATCHES: readonly ExportPatch[] = [
  {
    name: "sortChildren",
    anchor:
      /function sortChildren\(node\) \{\s*node\.children\.sort\(\(a, b\) =>\s*new Date\(a\.entry\.timestamp\)\.getTime\(\) - new Date\(b\.entry\.timestamp\)\.getTime\(\)\s*\);\s*node\.children\.forEach\(sortChildren\);\s*\}/g,
    replacement: `function sortChildren(root) {
          const pending = [root];
          while (pending.length > 0) {
            const next = pending.pop();
            next.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
            for (const child of next.children) pending.push(child);
          }
        }`,
  },
  {
    name: "mapNodes",
    anchor:
      /function mapNodes\(node\) \{\s*treeNodeMap\.set\(node\.entry\.id, node\);\s*node\.children\.forEach\(mapNodes\);\s*\}\s*tree\.forEach\(mapNodes\);/g,
    replacement: `const pending = [...tree];
          while (pending.length > 0) {
            const next = pending.pop();
            treeNodeMap.set(next.entry.id, next);
            for (const child of next.children) pending.push(child);
          }`,
  },
  {
    name: "markActive",
    anchor:
      /function markActive\(node\) \{\s*let has = activePathIds\.has\(node\.entry\.id\);\s*for \(const child of node\.children\) \{\s*if \(markActive\(child\)\) has = true;\s*\}\s*containsActive\.set\(node, has\);\s*return has;\s*\}/g,
    replacement: `function markActive(root) {
          const order = [];
          const pending = [root];
          while (pending.length > 0) {
            const next = pending.pop();
            order.push(next);
            for (const child of next.children) pending.push(child);
          }
          for (let index = order.length - 1; index >= 0; index--) {
            const next = order[index];
            let has = activePathIds.has(next.entry.id);
            for (const child of next.children) if (containsActive.get(child)) has = true;
            containsActive.set(next, has);
          }
          return containsActive.get(root) === true;
        }`,
  },
];

/** All three helpers or none: a template that changed is served as Pi wrote it. `skipped` names the anchor that failed. */
export function patchExportHtml(html: string): { html: string; skipped: string | null } {
  let out = html;
  for (const patch of EXPORT_PATCHES) {
    if ((out.match(patch.anchor)?.length ?? 0) !== 1) return { html, skipped: patch.name };
    out = out.replace(patch.anchor, () => patch.replacement);
  }
  return { html: out, skipped: null };
}

/**
 * Patches an exported file in place (a temporary file and a rename). Never throws: a file that is too large, cannot be
 * read or written, or does not match is served as it is, and the reason is logged (a code, never the path).
 */
export async function patchExportFile(
  path: string,
  logger: Logger,
  options: { maxBytes?: number } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_PATCH_BYTES;
  const temp = `${path}.patching`;
  try {
    if ((await stat(path)).size > maxBytes) {
      logger.warn("export_patch_too_large", { limit: maxBytes });
      return;
    }
    const { html, skipped } = patchExportHtml(await readFile(path, "utf8"));
    if (skipped) {
      logger.warn("export_patch_skipped", { anchor: skipped });
      return;
    }
    await writeFile(temp, html, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    logger.warn("export_patch_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
  } finally {
    await rm(temp, { force: true }).catch((error: unknown) =>
      logger.warn("export_patch_cleanup_failed", {
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      }),
    );
  }
}
