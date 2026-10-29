import { describe, expect, it } from "vitest";
import { fakeClock } from "../../testing/guest-harness.ts";
import type { NsDialer } from "./ns-dial.ts";
import { createNsDialerPool, NS_HELPER_IDLE_MS, NS_HELPERS_MAX } from "./ns-pool.ts";

// Mutants, each killed by the case named:
//  - one helper per connection (no sharing)         -> "shares one helper per namespace ..."
//  - the helper kept after its last user and idle   -> "stops a helper that stayed idle ..."
//  - the helper stopped while a connection uses it  -> "keeps the helper while a connection uses it"
//  - the descriptor kept by the guest after start   -> "closes the guest's own descriptor ..."
//  - a dead helper reused                           -> "starts a new helper when the old one died"

function bed(opens: Array<number | null> = []) {
  const clock = fakeClock();
  const events: string[] = [];
  const helpers: Array<{ closed: boolean; alive: boolean; dials: number }> = [];
  const pool = createNsDialerPool({
    clock,
    open: (target) => {
      events.push(`open ${target.pid}:${target.start}`);
      return opens.length > 0 ? (opens.shift() as number | null) : 7;
    },
    start: (fd) => {
      events.push(`start ${fd}`);
      const state = { closed: false, alive: true, dials: 0 };
      helpers.push(state);
      const dialer: NsDialer = {
        dial: () => {
          state.dials++;
          return Promise.reject(new Error("fake"));
        },
        alive: () => state.alive,
        close: () => {
          state.closed = true;
        },
      };
      return dialer;
    },
    closeFd: (fd) => void events.push(`close ${fd}`),
    log: () => undefined,
  });
  return { pool, clock, events, helpers };
}
const target = { pid: 10, start: "500" };

describe("the namespace helper pool", () => {
  it("shares one helper per namespace and starts it lazily", async () => {
    const t = bed();
    expect(t.events).toEqual([]);
    const a = t.pool(target);
    const b = t.pool(target);
    t.pool({ pid: 11, start: "600" });
    expect(t.helpers).toHaveLength(2);
    await a?.connect("127.0.0.1", 8000).catch(() => undefined);
    await b?.connect("127.0.0.1", 8000).catch(() => undefined);
    expect(t.helpers[0]?.dials).toBe(2);
  });

  it("closes the guest's own descriptor right after the helper started, and nothing is opened for a null namespace", () => {
    const t = bed([7, null]);
    t.pool(target);
    expect(t.events).toEqual(["open 10:500", "start 7", "close 7"]);
    expect(t.pool({ pid: 12, start: "700" })).toBeNull();
    expect(t.helpers).toHaveLength(1);
  });

  it("keeps the helper while a connection uses it, and stops one that stayed idle", () => {
    const t = bed();
    const a = t.pool(target);
    const b = t.pool(target);
    a?.close();
    a?.close();
    t.clock.advance(NS_HELPER_IDLE_MS + 1);
    expect(t.helpers[0]?.closed).toBe(false);
    b?.close();
    t.clock.advance(NS_HELPER_IDLE_MS - 1);
    expect(t.helpers[0]?.closed).toBe(false);
    t.clock.advance(2);
    expect(t.helpers[0]?.closed).toBe(true);
  });

  it("reuses an idle helper that is still within its time", () => {
    const t = bed();
    t.pool(target)?.close();
    t.clock.advance(NS_HELPER_IDLE_MS - 1);
    const again = t.pool(target);
    t.clock.advance(NS_HELPER_IDLE_MS);
    expect(t.helpers).toHaveLength(1);
    expect(t.helpers[0]?.closed).toBe(false);
    again?.close();
  });

  it("starts a new helper when the old one died", () => {
    const t = bed();
    t.pool(target);
    (t.helpers[0] as { alive: boolean }).alive = false;
    t.pool(target);
    expect(t.helpers).toHaveLength(2);
    expect(t.helpers[0]?.closed).toBe(true);
  });

  it("caps the helpers: idle ones make room for a new namespace, and when all are in use the answer is null", () => {
    const t = bed();
    const held = Array.from({ length: NS_HELPERS_MAX }, (_, n) => t.pool({ pid: 20 + n, start: "1" }));
    expect(t.helpers).toHaveLength(NS_HELPERS_MAX);
    expect(t.pool({ pid: 99, start: "1" })).toBeNull();
    expect(t.helpers).toHaveLength(NS_HELPERS_MAX);
    held[0]?.close();
    held[1]?.close();
    const fresh = t.pool({ pid: 99, start: "1" });
    expect(fresh).not.toBeNull();
    expect(t.helpers).toHaveLength(NS_HELPERS_MAX + 1);
    expect(t.helpers.filter((helper) => helper.closed)).toHaveLength(2);
    held[2]?.close();
  });

  it("refuses a host that is not loopback", async () => {
    const t = bed();
    await expect(t.pool(target)?.connect("10.0.0.1", 8000)).rejects.toThrow("loopback");
    expect(t.helpers[0]?.dials).toBe(0);
  });
});
