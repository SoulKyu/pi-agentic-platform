/** The runs registry's task spend as the runner bed fakes it: the open runs by session, each tied to the task it belongs to. */
export function createTaskSpend() {
  const taskOf = new Map<string, string>();
  const open = new Map<string, number>();
  return {
    /** The session's run costs `cost` so far. */
    live: (sessionId: string, cost: number): void => void open.set(sessionId, cost),
    /** The session's next run belongs to the task (a child's carries its parent's, M11R138). */
    begin: (sessionId: string, taskId: string): void => void taskOf.set(sessionId, taskId),
    /** The run is over: it no longer counts as open (the task stays tied to the session, as its next run is the task's too). */
    end: (sessionId: string): void => void open.delete(sessionId),
    openTaskOf: (sessionId: string): string | null => taskOf.get(sessionId) ?? null,
    spentByTask(_ownerId: string, taskId: string): number {
      let total = 0;
      for (const [sessionId, cost] of open) if (taskOf.get(sessionId) === taskId) total += cost;
      return total;
    },
  };
}
