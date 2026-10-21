import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEvents } from "./events.ts";
import { createAgentsBed, type AgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const AGENT = "atlas-0000";
const DATA = {
  host: "prometheus.lan",
  port: 9090,
  reason: "not_listed",
  address: null,
  source: "thread",
  count: 1,
  firstAt: 1,
  lastAt: 1,
};

function setup() {
  bed = createAgentsBed();
  bed.db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ($id, 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    { id: AGENT },
  );
  const bump = vi.fn();
  const written = vi.fn();
  const events = createAgentEvents({
    db: bed.db,
    clock: bed.clock,
    logger: { warn: vi.fn() },
    unread: { bump },
    written,
  });
  return { events, bump, written };
}

describe("the egress_refused card", () => {
  it("is written, read back, and moved by update without a second unread", () => {
    const { events, bump, written } = setup();
    const id = events.write("u1", AGENT, "egress_refused", null, DATA);
    expect(id).not.toBeNull();
    expect(bump).toHaveBeenCalledTimes(1);
    expect(events.update("u1", id ?? 0, { ...DATA, count: 7, lastAt: 9 })).toBe(true);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenLastCalledWith("u1", AGENT, id);
    const [view] = events.list("u1", AGENT).events;
    expect(view).toMatchObject({
      kind: "egress_refused",
      data: { count: 7, lastAt: 9, host: "prometheus.lan" },
    });
  });

  it("refuses an update that does not fit the kind, or for another owner, or for a card that is gone", () => {
    const { events } = setup();
    const id = events.write("u1", AGENT, "egress_refused", null, DATA) ?? 0;
    expect(events.update("u1", id, { ...DATA, count: 0 })).toBe(false);
    expect(events.update("u1", id, { ...DATA, extra: 1 })).toBe(false);
    expect(events.update("u2", id, DATA)).toBe(false);
    expect(events.update("u1", id + 99, DATA)).toBe(false);
    expect(events.list("u1", AGENT).events[0]).toMatchObject({ data: { count: 1 } });
  });

  it("keeps the cards that were there before the migration rebuilt the table", () => {
    const { events } = setup();
    events.notify("u1", AGENT, { text: "hello", itemId: "i1" });
    expect(events.list("u1", AGENT).events.map((e) => e.kind)).toEqual(["notify"]);
  });
});
