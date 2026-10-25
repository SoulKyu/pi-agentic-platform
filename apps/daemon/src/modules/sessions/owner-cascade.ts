import { rmSync } from "node:fs";
import { mirrorFileOf, removeMirrorFiles } from "../agent-vm/index.ts";
import type { AutomationContext } from "./automation-port.ts";
import { isPiSessionFile } from "./pi-files.ts";

/** What a member's delete (A5b) asks of the sessions module. */
export interface SessionsOwnerCascade {
  /**
   * Stops every live session of the owner and removes all their rows (the policy rows cascade), the files pap keeps for them
   * (a Pi file under Pi's folder, a VM mirror, uploaded attachments) and the HTML exports waiting to be downloaded.
   * A file that cannot be removed is logged and does not stop the delete.
   */
  removeAll(ownerId: string): Promise<{ sessions: number }>;
}

export function createSessionsOwnerCascade(ctx: AutomationContext): SessionsOwnerCascade {
  const { deps, live, reopening } = ctx;
  return {
    async removeAll(ownerId) {
      const rows = deps.store.listByOwner(ownerId);
      for (const row of rows) {
        const pending = reopening.get(row.id);
        const session = live.get(row.id) ?? (pending ? await pending.catch(() => undefined) : undefined);
        await session?.stop();
        const projectId = ctx.marks.row(row.id)?.projectId ?? undefined;
        deps.store.remove(row.id);
        ctx.removed(row);
        const file = row.piPath;
        try {
          if (file && isPiSessionFile(deps.worker.agentDir, file)) rmSync(file, { force: true });
          else if (file && mirrorFileOf(deps.worker.papHome, { ...row, projectId }) !== null)
            removeMirrorFiles(file);
        } catch (error) {
          deps.logger.warn("owner_session_file_not_removed", { sessionId: row.id, err: error });
        }
      }
      deps.attachments.dropOwner(
        ownerId,
        rows.map((row) => row.id),
      );
      deps.exports.discardOwner(ownerId);
      if (rows.length > 0) ctx.publisher.countsChanged(ownerId);
      return { sessions: rows.length };
    },
  };
}
