import type { SessionCost, SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createSessionCost } from "./session-cost.ts";

const cost = (sessionUsd: number): SessionCost => ({ sessionUsd, runUsd: null, billing: "api" });

function setup(parents: Record<string, string> = {}) {
  const clock = createFakeClock();
  const published: Array<{ id: string; event: SessionStreamEvent }> = [];
  const hub = {
    publish: (_stream: string, id: string, event: SessionStreamEvent) => published.push({ id, event }),
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const port = createSessionCost({
    hub: hub as never,
    clock,
    logger: logger as never,
    store: { get: (id: string) => (parents[id] ? { parentSessionId: parents[id] } : {}) } as never,
  });
  const values = new Map<string, SessionCost | null>();
  const costOf = vi.fn((id: string) => values.get(id) ?? null);
  port.bind({ costOf });
  return { clock, published, port, values, costOf };
}

const costs = (published: Array<{ id: string; event: SessionStreamEvent }>, id: string) =>
  published.filter((p) => p.id === id).map((p) => (p.event.kind === "cost" ? p.event.cost.sessionUsd : -1));

describe("session cost port", () => {
  it("the first change publishes at once; three more inside the second publish once, the latest, at the window's end", async () => {
    const { clock, published, port, values, costOf } = setup();
    values.set("s", cost(1));
    port.changed("s");
    expect(costs(published, "s")).toEqual([1]);
    values.set("s", cost(2));
    port.changed("s");
    values.set("s", cost(3));
    port.changed("s");
    values.set("s", cost(4));
    port.changed("s");
    expect(costs(published, "s")).toEqual([1]);
    expect(costOf).toHaveBeenCalledTimes(1);
    await clock.advance(1000);
    expect(costs(published, "s")).toEqual([1, 4]);
    expect(costOf).toHaveBeenCalledTimes(2);
    await clock.advance(1000);
    expect(costs(published, "s")).toEqual([1, 4]);
    expect(clock.pending()).toBe(0);
  });

  it("a child's run start and end refresh its parent; its live cost does not", () => {
    const { published, port, values } = setup({ child: "parent" });
    values.set("child", cost(1));
    values.set("parent", cost(5));
    port.changed("child");
    expect(published.map((p) => p.id)).toEqual(["child"]);
    port.changed("child", { parent: true });
    expect(published.map((p) => p.id)).toEqual(["child", "parent"]);
  });

  it("past 256 open windows a change publishes at once and nothing is dropped", () => {
    const { clock, published, port, values } = setup();
    for (let i = 0; i < 300; i++) {
      values.set(`s${i}`, cost(i + 1));
      port.changed(`s${i}`);
    }
    expect(published).toHaveLength(300);
    expect(clock.pending()).toBe(256);
    values.set("s299", cost(999));
    port.changed("s299");
    expect(published).toHaveLength(301);
  });

  it("a session with no run publishes nothing; its snapshot cost is null", () => {
    const { published, port, clock } = setup();
    port.changed("none");
    expect(published).toEqual([]);
    expect(port.snapshotOf("none")).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("stop leaves no timer", () => {
    const { clock, port, values } = setup();
    values.set("s", cost(1));
    port.changed("s");
    expect(clock.pending()).toBe(1);
    port.stop();
    expect(clock.pending()).toBe(0);
  });
});
