import { afterEach, describe, expect, it } from "vitest";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

describe("a box_paused item (a project box, no agent)", () => {
  it("is stored with the project's name as its subject, no agent id, and shows on the stream as an info item", () => {
    bed = createInboxBed();
    const frames = bed.open("u1");
    const written = bed.inbox.agentItems.upsertAgentItem({
      ownerId: "u1",
      kind: "box_paused",
      agentId: null,
      title: "Api",
      refId: "pause-1",
      detail: "La box s'est arrêtée trois fois en dix minutes ; elle est en pause.",
      toHandle: false,
    });
    expect(written).toBe(true);
    expect(bed.rows()).toEqual([
      expect.objectContaining({ kind: "box_paused", agent_id: null, title: "Api", to_handle: 0 }),
    ]);
    expect(
      frames.some(
        (frame) =>
          JSON.stringify(frame).includes('"triggerName":"Api"') &&
          JSON.stringify(frame).includes('"agentId":null'),
      ),
    ).toBe(true);
  });
});
