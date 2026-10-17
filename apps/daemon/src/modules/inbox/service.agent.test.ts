import { afterEach, describe, expect, it } from "vitest";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

const AGENT = "atlas-1a2b";
let bed: InboxBed;
afterEach(() => bed.dispose());

describe("the Inbox items of an agent's task (M11R92)", () => {
  it("carry the agent on the ending item and on the question, and none on a project task's", () => {
    bed = createInboxBed();
    bed.addTask("t1", "u1", "Atlas nightly", "s-t1", AGENT);
    bed.addTask("t2", "u1", "prod-alerts", "s-t2");
    bed.attend("t1", true);
    bed.move("t1", "done");
    bed.move("t2", "done");
    expect(bed.row("t1", "task_needs_input")).toMatchObject({ agent_id: AGENT });
    expect(bed.row("t1", "task_done")).toMatchObject({ agent_id: AGENT });
    expect(bed.row("t2", "task_done")).toMatchObject({ agent_id: null });
  });

  it("show under Tasks with the agent, so the row opens the agent", () => {
    bed = createInboxBed();
    bed.addTask("t1", "u1", "Atlas nightly", "s-t1", AGENT);
    bed.move("t1", "failed");
    const [item] = bed.inbox.list("u1", undefined, "tasks").items;
    expect(item).toMatchObject({ kind: "task_failed", taskId: "t1", agentId: AGENT });
  });
});
