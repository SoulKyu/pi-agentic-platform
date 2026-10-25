import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createParked } from "./parked.ts";
import { PER_USER } from "./per-user-cap.ts";
import { createStates } from "./states.ts";

describe("per-user caps on the GitHub stored states and parked tickets (M14 J1)", () => {
  it("a member flooding states never evicts the owner's pending sign-in", () => {
    const states = createStates({ clock: createFakeClock() });
    const owner = states.issue("owner", "authorize");
    for (let i = 0; i < 500; i += 1) states.issue("member", "authorize");
    expect(states.take(owner, "authorize")).toMatchObject({ userId: "owner" });
  });

  it("one user holds at most PER_USER states, the oldest of their own going first", () => {
    const states = createStates({ clock: createFakeClock() });
    const issued = Array.from({ length: PER_USER + 1 }, () => states.issue("member"));
    expect(states.consume(issued[0] ?? "", "member")).toBe(false);
    expect(states.consume(issued[1] ?? "", "member")).toBe(true);
  });

  it("a member flooding parked tickets never evicts the owner's", () => {
    const parked = createParked({ clock: createFakeClock() });
    const pair = { access_token: "a", refresh_token: "r", expires_in: 1, refresh_token_expires_in: 1 };
    const owner = parked.park({ userId: "owner", origin: "o", pair });
    for (let i = 0; i < 200; i += 1) parked.park({ userId: "member", origin: "o", pair });
    expect(parked.peek(owner)).not.toBeNull();
  });

  it("past the global ceiling the heaviest user pays, not the light one", () => {
    const states = createStates({ clock: createFakeClock() });
    const light = states.issue("light");
    for (let u = 0; u < 20; u += 1) for (let i = 0; i < PER_USER; i += 1) states.issue(`heavy-${u}`);
    expect(states.consume(light, "light")).toBe(true);
  });
});
