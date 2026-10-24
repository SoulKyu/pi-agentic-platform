import type { AutomationContext } from "./automation-port.ts";
import type { SessionRow } from "./store.ts";

/** What the projects module asks of the sessions when a box project is deleted (boxes B1). */
export interface SessionsProjectPort {
  /** The owner's sessions filed under the project, archived ones included: the delete confirmation names them. */
  count(ownerId: string, projectId: string): number;
  /**
   * Stops the project's live sessions, removes their rows (the policy rows cascade) and says so to the sidebar. Returns
   * how many it removed. No file is touched: a box project's Pi files and mirrors move to the trash with the box
   * (`BoxControl.dispose`, called first), and the scanner prunes the search rows.
   */
  removeProject(ownerId: string, projectId: string): Promise<{ sessions: number }>;
  /** The ids of the project's sessions that run now (a notice about the box is posted to these only). */
  liveIds(ownerId: string, projectId: string): string[];
}

export function createSessionsProjectPort(ctx: AutomationContext): SessionsProjectPort {
  const { deps, live, reopening } = ctx;
  const rowsOf = (ownerId: string, projectId: string): SessionRow[] =>
    deps.store
      .listByOwner(ownerId)
      .filter((row) => row.agentId === undefined && ctx.marks.row(row.id)?.projectId === projectId);

  async function stop(sessionId: string): Promise<void> {
    const pending = reopening.get(sessionId);
    const session = live.get(sessionId) ?? (pending ? await pending.catch(() => undefined) : undefined);
    await session?.stop();
  }

  return {
    count: (ownerId, projectId) => rowsOf(ownerId, projectId).length,
    liveIds: (ownerId, projectId) =>
      rowsOf(ownerId, projectId)
        .map((row) => row.id)
        .filter((id) => live.has(id)),
    async removeProject(ownerId, projectId) {
      const rows = rowsOf(ownerId, projectId);
      for (const row of rows) {
        await stop(row.id);
        deps.store.remove(row.id);
        ctx.removed(row);
      }
      if (rows.length > 0) ctx.publisher.countsChanged(ownerId);
      return { sessions: rows.length };
    },
  };
}
