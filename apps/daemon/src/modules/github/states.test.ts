import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createStates, STATE_TTL_MS } from "./states.ts";

describe("states", () => {
  it("a state is single-use, expires, and binds the user", async () => {
    const clock = createFakeClock();
    const states = createStates({ clock });
    const state = states.issue("u1");
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(states.consume(state, "u2")).toBe(false); // foreign: refused and kept
    expect(states.consume("0".repeat(32), "u1")).toBe(false); // unknown
    expect(states.consume(state, "u1")).toBe(true);
    expect(states.consume(state, "u1")).toBe(false); // single use
    const late = states.issue("u1");
    await clock.advance(STATE_TTL_MS);
    expect(states.consume(late, "u1")).toBe(false);
    const fresh = states.issue("u1");
    await clock.advance(STATE_TTL_MS - 1);
    expect(states.consume(fresh, "u1")).toBe(true);
  });

  it("holds a bounded number of states", () => {
    const states = createStates({ clock: createFakeClock() });
    const first = states.issue("u1");
    for (let i = 0; i < 100; i += 1) states.issue("u1");
    expect(states.consume(first, "u1")).toBe(false);
  });
});
