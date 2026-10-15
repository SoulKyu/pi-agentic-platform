import { describe, expect, it } from "vitest";
import { createBackoff } from "./backoff.ts";
import { createFakeClock } from "../../kernel/clock.ts";

const ID = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";

describe("failure backoff", () => {
  it("blocks failing requests for 60 s after 10 failures within 60 s, then lets them through", async () => {
    const clock = createFakeClock();
    const backoff = createBackoff(clock);
    for (let i = 0; i < 9; i++) expect(backoff.failed(ID)).toBe(false);
    expect(backoff.blocked(ID)).toBe(false);
    expect(backoff.failed(ID)).toBe(true);
    expect(backoff.blocked(ID)).toBe(true);
    await clock.advance(59_999);
    expect(backoff.blocked(ID)).toBe(true);
    await clock.advance(1);
    expect(backoff.blocked(ID)).toBe(false);
  });
  it("forgets failures older than 60 s", async () => {
    const clock = createFakeClock();
    const backoff = createBackoff(clock);
    for (let i = 0; i < 9; i++) backoff.failed(ID);
    await clock.advance(60_000);
    expect(backoff.failed(ID)).toBe(false);
    expect(backoff.blocked(ID)).toBe(false);
  });
  it("keeps triggers apart and makes unknown ids share one state", () => {
    const backoff = createBackoff(createFakeClock());
    for (let i = 0; i < 10; i++) backoff.failed(null);
    expect(backoff.blocked(null)).toBe(true);
    expect(backoff.blocked(ID)).toBe(false);
    expect(backoff.size()).toBe(1);
  });
  it("drops a deleted trigger's entry", () => {
    const backoff = createBackoff(createFakeClock());
    backoff.failed(ID);
    expect(backoff.size()).toBe(1);
    backoff.forget(ID);
    expect(backoff.size()).toBe(0);
  });
});
