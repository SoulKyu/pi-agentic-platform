import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";

/** pap's session ids (`randomUUID`): the only names the cleanup deletes; `pending/` and anything else stay. */
const SESSION_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Folders removed per pass: the handler defers the rest by a minute, so the loop never holds the event loop long (RT-35). */
export const CLEANUP_MAX_FOLDERS = 50;
/** Entries looked at per pass, removed or kept: a home with many kept folders still ends a pass quickly. */
const CLEANUP_MAX_SCANNED = 5_000;

/**
 * Deletes `<root>/<session id>/` for the sessions `expired` names, at most 50 a pass; `more` says a next pass has work.
 * Only real folders (the directory entry's own type, never followed) directly under a root that is itself a real
 * folder: Node's `rm` unlinks a link it meets and never walks into one, even if a folder is swapped for a link
 * between the check and the removal.
 */
export async function cleanupAttachments(
  root: string,
  expired: (sessionId: string) => boolean,
): Promise<{ removed: number; kept: number; more: boolean }> {
  const top = await lstat(root).catch(() => null);
  if (!top?.isDirectory()) return { removed: 0, kept: 0, more: false };
  let removed = 0;
  let kept = 0;
  let more = false;
  const dir = await opendir(root);
  try {
    for await (const entry of dir) {
      if (removed >= CLEANUP_MAX_FOLDERS || removed + kept >= CLEANUP_MAX_SCANNED) {
        more = true;
        break;
      }
      if (!SESSION_FOLDER.test(entry.name) || !entry.isDirectory() || !expired(entry.name)) {
        kept++;
        continue;
      }
      await rm(join(root, entry.name), { recursive: true, force: true });
      removed++;
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return { removed, kept, more };
}
