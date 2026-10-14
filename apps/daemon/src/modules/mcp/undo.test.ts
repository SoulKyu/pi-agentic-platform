import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createUndoStore, UNDO_MAX_PER_OWNER, UNDO_TTL_MS, type UndoRecord } from "./undo.ts";

const record = (name: string): UndoRecord => ({
  scope: "global",
  name,
  entry: `{"command":"${name}"}`,
  index: 0,
});
const bed = () => {
  const clock = createFakeClock();
  let n = 0;
  return { clock, store: createUndoStore({ clock, newToken: () => `t${(n += 1)}` }) };
};

describe("undo store (M7R90)", () => {
  it("hands out a token and takes the record once", () => {
    const { store } = bed();
    const { token, expiresInMs } = store.put("u1", record("a"));
    expect(expiresInMs).toBe(UNDO_TTL_MS);
    expect(store.peek("u1", token)).toEqual(record("a"));
    expect(store.take("u1", token)).toEqual(record("a"));
    expect(store.take("u1", token)).toBeUndefined();
  });

  it("refuses the 101st pending removal of an owner and evicts nothing", () => {
    const { store } = bed();
    const tokens = Array.from(
      { length: UNDO_MAX_PER_OWNER },
      (_, i) => store.put("u1", record(`s${i}`)).token,
    );
    expect(() => store.requireRoom("u1")).toThrow(new PapError("limit_reached"));
    expect(() => store.put("u1", record("one-more"))).toThrow(new PapError("limit_reached"));
    expect(store.peek("u1", tokens[0] as string)).toEqual(record("s0"));
    expect(() => store.put("u2", record("other-owner"))).not.toThrow();
  });

  it("makes room again once a record is taken or expired", async () => {
    const { store, clock } = bed();
    const tokens = Array.from(
      { length: UNDO_MAX_PER_OWNER },
      (_, i) => store.put("u1", record(`s${i}`)).token,
    );
    store.take("u1", tokens[0] as string);
    expect(() => store.put("u1", record("x"))).not.toThrow();
    await clock.advance(UNDO_TTL_MS);
    expect(() => store.requireRoom("u1")).not.toThrow();
  });

  it("answers nothing for another owner's token", () => {
    const { store } = bed();
    const { token } = store.put("u1", record("a"));
    expect(store.peek("u2", token)).toBeUndefined();
    expect(store.take("u2", token)).toBeUndefined();
    expect(store.take("u1", token)).toEqual(record("a"));
  });

  it("expires at 60 s on the injected clock", async () => {
    const { store, clock } = bed();
    const { token } = store.put("u1", record("a"));
    await clock.advance(UNDO_TTL_MS - 1);
    expect(store.peek("u1", token)).toBeDefined();
    await clock.advance(1);
    expect(store.peek("u1", token)).toBeUndefined();
  });

  it("deletes a record by its own timer at expiry, and cancels the timer when it is taken (MC44 M3)", async () => {
    const { store, clock } = bed();
    const first = store.put("u1", record("a"));
    const second = store.put("u1", record("b"));
    expect(clock.pending()).toBe(2);
    store.take("u1", first.token);
    expect(clock.pending()).toBe(1);
    await clock.advance(UNDO_TTL_MS);
    expect(clock.pending()).toBe(0);
    expect(store.size()).toBe(0);
    expect(store.peek("u1", second.token)).toBeUndefined();
  });

  it("draws unguessable tokens by default", () => {
    const store = createUndoStore({ clock: createFakeClock() });
    const a = store.put("u1", record("a")).token;
    const b = store.put("u1", record("b")).token;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
