/** A session snapshot as the server's first event would carry it; `patch` overrides any field. */
export function sessionSnapshot(patch: Record<string, unknown> = {}) {
  return {
    kind: "snapshot",
    status: "idle",
    rows: [],
    dialogs: [],
    partial: null,
    queue: { steering: [], followUp: [], count: 0, bytes: 0 },
    statuses: [],
    widgets: [],
    title: null,
    panels: [],
    notices: [],
    decorationsTruncated: false,
    history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
    activity: { compacting: false, retry: null },
    leafId: null,
    name: null,
    ...patch,
  };
}
