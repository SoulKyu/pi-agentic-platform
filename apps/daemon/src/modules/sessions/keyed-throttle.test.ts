import type { SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createKeyedThrottle } from "./keyed-throttle.ts";

const status = (key: string, text: string): SessionStreamEvent => ({ kind: "status_bar", key, text });

function setup() {
  const clock = createFakeClock();
  const out: SessionStreamEvent[] = [];
  const throttle = createKeyedThrottle({ clock, publish: (event) => out.push(event) });
  return { clock, out, throttle };
}

describe("keyed throttle", () => {
  it("publishes the first event of a key at once and folds the rest of the window into the latest", async () => {
    const { clock, out, throttle } = setup();
    throttle.push("status:git", status("git", "0"));
    for (let i = 1; i < 60; i++) {
      await clock.advance(40 / 59);
      throttle.push("status:git", status("git", String(i)));
    }
    expect(out).toEqual([status("git", "0")]);
    await clock.advance(50);
    expect(out).toEqual([status("git", "0"), status("git", "59")]);
  });

  it("publishes a sustained 60 Hz stream about 20 times a second, the latest value last", async () => {
    const { clock, out, throttle } = setup();
    for (let i = 0; i < 60; i++) {
      throttle.push("status:git", status("git", String(i)));
      await clock.advance(1000 / 60);
    }
    await clock.advance(1);
    expect(out).toHaveLength(21);
    expect(out.at(-1)).toEqual(status("git", "59"));
    await clock.advance(50);
    expect(clock.pending()).toBe(0);
  });

  it("keeps one window per key", async () => {
    const { clock, out, throttle } = setup();
    throttle.push("status:a", status("a", "1"));
    throttle.push("status:b", status("b", "1"));
    throttle.push("status:a", status("a", "2"));
    throttle.push("status:b", status("b", "2"));
    expect(out).toEqual([status("a", "1"), status("b", "1")]);
    await clock.advance(50);
    expect(out.slice(2)).toEqual([status("a", "2"), status("b", "2")]);
  });

  it("opens a new window after the quiet one and leaves no timer behind", async () => {
    const { clock, out, throttle } = setup();
    throttle.push("k", status("k", "1"));
    await clock.advance(50);
    expect(clock.pending()).toBe(0);
    throttle.push("k", status("k", "2"));
    expect(out).toEqual([status("k", "1"), status("k", "2")]);
  });

  it("publishes at once when 64 keys are pending, and drops nothing", async () => {
    const { clock, out, throttle } = setup();
    for (let i = 0; i < 64; i++) throttle.push(`k${i}`, status(`k${i}`, "1"));
    throttle.push("k64", status("k64", "1"));
    throttle.push("k64", status("k64", "2"));
    expect(out).toHaveLength(66);
    expect(out.slice(64)).toEqual([status("k64", "1"), status("k64", "2")]);
    await clock.advance(50);
    expect(clock.pending()).toBe(0);
  });

  it("flush(key) sends the pending value now and ends the window; flush() does it for every key", async () => {
    const { clock, out, throttle } = setup();
    throttle.push("a", status("a", "1"));
    throttle.push("a", status("a", "2"));
    throttle.push("b", status("b", "1"));
    throttle.push("b", status("b", "2"));
    throttle.flush("a");
    expect(out.slice(2)).toEqual([status("a", "2")]);
    throttle.flush("a");
    expect(out).toHaveLength(3);
    throttle.flush();
    expect(out.slice(3)).toEqual([status("b", "2")]);
    expect(clock.pending()).toBe(0);
  });

  it("drop(key) forgets the pending value and its timer", async () => {
    const { clock, out, throttle } = setup();
    throttle.push("a", status("a", "1"));
    throttle.push("a", status("a", "2"));
    throttle.drop("a");
    expect(clock.pending()).toBe(0);
    await clock.advance(100);
    expect(out).toEqual([status("a", "1")]);
  });

  it("clear() leaves no timer and publishes nothing", async () => {
    const { clock, out, throttle } = setup();
    for (let i = 0; i < 10; i++) {
      throttle.push(`k${i}`, status(`k${i}`, "1"));
      throttle.push(`k${i}`, status(`k${i}`, "2"));
    }
    throttle.clear();
    expect(clock.pending()).toBe(0);
    await clock.advance(100);
    expect(out).toHaveLength(10);
  });
});
