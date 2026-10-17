import { describe, expect, it } from "vitest";
import { CHILD_VIEWS, ChildView, SessionStreamEvent } from "./index.ts";

const approval = {
  id: "d1",
  method: "approval",
  title: "Run a command?",
  message: "bash: ls",
  category: "exec",
  answers: ["deny", "once"],
};
const child = {
  id: "c1",
  runId: "r1",
  title: "Find the bug",
  profile: null,
  state: "running",
  costUsd: 0.25,
  dialogs: [approval],
  hiddenDialogs: 0,
};

describe("the parent's view of its children (M11R140)", () => {
  it("carries the child's own session id, its state, its cost and its open dialogs", () => {
    expect(ChildView.parse(child)).toMatchObject({ id: "c1", state: "running", dialogs: [{ id: "d1" }] });
    expect(ChildView.safeParse({ ...child, extra: 1 }).success).toBe(false);
    expect(ChildView.safeParse({ ...child, state: "paused" }).success).toBe(false);
    expect(ChildView.safeParse({ ...child, dialogs: [{ id: "x" }] }).success).toBe(false);
  });

  it("is a stream event of its own, at most eight children", () => {
    expect(SessionStreamEvent.safeParse({ kind: "subagents", children: [child] }).success).toBe(true);
    expect(CHILD_VIEWS).toBe(8);
    const nine = Array.from({ length: 9 }, (_, index) => ({ ...child, id: `c${index}` }));
    expect(SessionStreamEvent.safeParse({ kind: "subagents", children: nine }).success).toBe(false);
  });

  it("is a snapshot field that an older daemon leaves out", () => {
    const base = {
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
    };
    expect(SessionStreamEvent.parse(base)).toMatchObject({ children: [], hiddenChildren: 0 });
    expect(SessionStreamEvent.parse({ ...base, hiddenChildren: 3 })).toMatchObject({ hiddenChildren: 3 });
    expect(SessionStreamEvent.safeParse({ ...base, hiddenChildren: -1 }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ ...base, hiddenChildren: 9 }).success).toBe(false);
    expect(SessionStreamEvent.parse({ ...base, children: [child] })).toMatchObject({
      children: [{ id: "c1" }],
    });
  });
});
