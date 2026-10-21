import { describe, expect, it, vi } from "vitest";
import { entryFor } from "@pap/contracts";
import { createFakeClock } from "../../kernel/clock.ts";
import { createRefusalSink } from "./egress-refusals.ts";

/*
 * Mutants run for real: "dedupe key without the port" (the second-port case), "window never expires" (the 61 minutes case),
 * "no count update" (the 200 case), "item written on every refusal" (the 200 case).
 */
const AGENT = "kubedoc-1a2b";
const HOUR = 3_600_000;

const refusal = (over: Partial<Parameters<ReturnType<typeof createRefusalSink>>[0]> = {}) => ({
  agentId: AGENT,
  launchId: "l1",
  source: "thread" as const,
  host: "prometheus.lan",
  port: 9090,
  reason: "not_listed" as const,
  address: null,
  ...over,
});

function setup() {
  const clock = createFakeClock();
  let next = 10;
  const written: unknown[] = [];
  const events = {
    write: vi.fn((_o: string, _a: string, _k: string, _t: null, data: unknown) => {
      written.push(data);
      return next++;
    }),
    update: vi.fn<(owner: string, id: number, data: unknown) => boolean>(() => true),
  };
  const items = { upsertAgentItem: vi.fn<(input: { refId: string }) => boolean>(() => true) };
  const logger = { warn: vi.fn() };
  const sink = createRefusalSink({
    clock,
    logger,
    ownerOf: (agentId) => (agentId === AGENT || agentId === "other-3c4d" ? "u1" : null),
    events,
    items,
  });
  return { clock, events, items, logger, sink, written };
}

describe("entryFor", () => {
  it("is the bare host for 80 and 443 and host:port otherwise; IPv6 is bracketed", async () => {
    expect(entryFor("api.example.com", 443)).toBe("api.example.com");
    expect(entryFor("api.example.com", 80)).toBe("api.example.com");
    expect(entryFor("prometheus.lan", 9090)).toBe("prometheus.lan:9090");
    expect(entryFor("192.168.1.40", 6443)).toBe("192.168.1.40:6443");
    expect(entryFor("fd00::1", 6443)).toBe("[fd00::1]:6443");
    expect(entryFor("[fd00::1]", 443)).toBe("fd00::1");
  });
});

describe("the refusal sink", () => {
  it("dedupe: 200 refusals of one agent and host:port in 10 minutes are one card, one Inbox item, a final count of 200", async () => {
    const { clock, events, items, sink } = setup();
    for (let i = 0; i < 200; i++) {
      sink(refusal());
      await clock.advance(3_000);
    }
    expect(events.write).toHaveBeenCalledTimes(1);
    expect(items.upsertAgentItem).toHaveBeenCalledTimes(1);
    expect(items.upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "agent_egress",
      agentId: AGENT,
      refId: "10",
      detail: "prometheus.lan:9090",
      toHandle: false,
    });
    // One update a minute at most (I2): 10 minutes is 10 updates; the last one carries the exact count.
    expect(events.update.mock.calls.length).toBeLessThanOrEqual(11);
    await clock.advance(60_000);
    expect(events.update).toHaveBeenLastCalledWith("u1", 10, expect.objectContaining({ count: 200 }));
  });

  // I2 mutants (run for real): "no throttle" (the update is written at every refusal), "no timer" (the final count is lost).
  it("1000 refusals in a minute are at most one update per card per 60 s, and the count is exact once flushed", async () => {
    const { clock, events, sink } = setup();
    sink(refusal());
    sink(refusal({ host: "grafana.lan" }));
    for (let i = 0; i < 1000; i++) {
      sink(refusal());
      sink(refusal({ host: "grafana.lan" }));
      if (i % 100 === 0) await clock.advance(5_000);
    }
    expect(events.update).not.toHaveBeenCalled();
    await clock.advance(60_000);
    expect(events.update).toHaveBeenCalledTimes(2);
    const counts = events.update.mock.calls.map(([, id, data]) => [id, (data as { count: number }).count]);
    expect(counts).toEqual(
      expect.arrayContaining([
        [10, 1001],
        [11, 1001],
      ]),
    );
    // Quiet again: nothing more is written.
    await clock.advance(10 * 60_000);
    expect(events.update).toHaveBeenCalledTimes(2);
  });

  it("an update after the minute is written at once, and a card the database lost is forgotten", async () => {
    const { clock, events, sink } = setup();
    sink(refusal());
    await clock.advance(61_000);
    sink(refusal());
    expect(events.update).toHaveBeenCalledTimes(1);
    events.update.mockReturnValueOnce(false);
    await clock.advance(61_000);
    sink(refusal());
    sink(refusal());
    expect(events.write).toHaveBeenCalledTimes(2);
  });

  it("writes the card with the host, port, reason, address, source and the times", async () => {
    const { clock, sink, written } = setup();
    await clock.advance(5);
    sink(refusal({ reason: "private_wildcard", address: "192.168.1.9", source: { task: "nightly" } }));
    expect(written).toEqual([
      {
        host: "prometheus.lan",
        port: 9090,
        reason: "private_wildcard",
        address: "192.168.1.9",
        source: "nightly",
        count: 1,
        firstAt: clock.now(),
        lastAt: clock.now(),
      },
    ]);
  });

  it("a refusal 61 minutes after the first gives a new card and a new Inbox item", async () => {
    const { clock, events, items, sink } = setup();
    sink(refusal());
    await clock.advance(61 * 60_000);
    sink(refusal());
    expect(events.write).toHaveBeenCalledTimes(2);
    expect(items.upsertAgentItem).toHaveBeenCalledTimes(2);
    expect(items.upsertAgentItem.mock.calls.map(([call]) => call.refId)).toEqual(["10", "11"]);
  });

  it("still one card 59 minutes in", async () => {
    const { clock, events, sink } = setup();
    sink(refusal());
    await clock.advance(HOUR - 60_000);
    sink(refusal());
    expect(events.write).toHaveBeenCalledTimes(1);
  });

  it("another host or port of the same agent has its own card", async () => {
    const { events, sink } = setup();
    sink(refusal());
    sink(refusal({ host: "grafana.lan" }));
    sink(refusal({ port: 9091 }));
    expect(events.write).toHaveBeenCalledTimes(3);
  });

  it("another agent has its own card", async () => {
    const { events, sink } = setup();
    sink(refusal());
    sink(refusal({ agentId: "other-3c4d" }));
    expect(events.write).toHaveBeenCalledTimes(2);
  });

  it("writes no Inbox item when the card was not written, and logs an unknown agent", async () => {
    const { events, items, logger, sink } = setup();
    events.write.mockReturnValueOnce(null as never);
    sink(refusal());
    expect(items.upsertAgentItem).not.toHaveBeenCalled();
    sink(refusal({ agentId: "ghost-0000" }));
    expect(logger.warn).toHaveBeenCalledWith("egress_refusal_unknown_agent", { agentId: "ghost-0000" });
  });

  it("an agent that tries many hosts gets at most 20 new cards an hour; the rest are only logged", async () => {
    const { clock, events, logger, sink } = setup();
    for (let i = 0; i < 30; i++) sink(refusal({ host: `h${i}.lan` }));
    expect(events.write).toHaveBeenCalledTimes(20);
    expect(logger.warn).toHaveBeenCalledWith("egress_refusal_card_cap", { agentId: AGENT });
    await clock.advance(HOUR + 1);
    sink(refusal({ host: "again.lan" }));
    expect(events.write).toHaveBeenCalledTimes(21);
  });

  it("logs the card cap and an unknown agent once per agent a minute, with the count it stands for (I2)", async () => {
    const { clock, logger, sink } = setup();
    for (let i = 0; i < 20; i++) sink(refusal({ host: `h${i}.lan` }));
    for (let i = 0; i < 1000; i++) sink(refusal({ host: `x${i}.lan` }));
    for (let i = 0; i < 1000; i++) sink(refusal({ agentId: "ghost-0000" }));
    const lines = () => logger.warn.mock.calls.map(([event, fields]) => [event, fields]);
    expect(lines()).toEqual([
      ["egress_refusal_card_cap", { agentId: AGENT }],
      ["egress_refusal_unknown_agent", { agentId: "ghost-0000" }],
    ]);
    await clock.advance(61_000);
    sink(refusal({ host: "late.lan" }));
    expect(lines().at(-1)).toEqual(["egress_refusal_card_cap", { agentId: AGENT, suppressed: 999 }]);
  });
});
