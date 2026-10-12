import { type SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createNoticeLimiter, createNoticeRing } from "./notices.ts";

describe("notice ring", () => {
  it("keeps the newest 20, texts cut to 2000 characters, and the source of each", () => {
    const ring = createNoticeRing();
    for (let i = 0; i < UI_LIMITS.notices + 5; i++) ring.add({ level: "info", text: `n${i}` });
    expect(ring.list()).toHaveLength(UI_LIMITS.notices);
    expect(ring.list()[0]).toEqual({ level: "info", text: "n5" });
    expect(ring.list().at(-1)).toEqual({ level: "info", text: "n24" });
    ring.add({ level: "warning", text: "é".repeat(5000), source: "extension" });
    expect(ring.list().at(-1)).toEqual({
      level: "warning",
      text: "é".repeat(UI_LIMITS.noticeText),
      source: "extension",
    });
    expect(ring.list()).toHaveLength(UI_LIMITS.notices);
  });
});

function setup() {
  const clock = createFakeClock();
  const out: SessionStreamEvent[] = [];
  const limiter = createNoticeLimiter({ clock, publish: (event) => out.push(event) });
  const say = (n: number) => limiter.add({ level: "info", text: `n${n}`, source: "extension" });
  return { clock, out, limiter, say };
}

describe("extension notice limiter", () => {
  it("publishes 10 notices, counts the next 5 and says so when the window ends, in pap's own words", async () => {
    const { clock, out, say } = setup();
    for (let i = 0; i < 15; i++) say(i);
    expect(out).toHaveLength(10);
    expect(out[9]).toEqual({ kind: "notice", level: "info", text: "n9", source: "extension" });
    await clock.advance(10_000);
    expect(out).toHaveLength(11);
    expect(out[10]).toEqual({
      kind: "notice",
      level: "warning",
      text: "5 more notices from extensions were not shown.",
      code: "notices_held_many",
      params: { count: "5" },
    });
    expect(clock.pending()).toBe(0);
  });

  it("starts a new window after it: the 16th notice is published", async () => {
    const { clock, out, say } = setup();
    for (let i = 0; i < 15; i++) say(i);
    await clock.advance(10_000);
    say(15);
    expect(out.at(-1)).toEqual({ kind: "notice", level: "info", text: "n15", source: "extension" });
    expect(out).toHaveLength(12);
  });

  it("says nothing extra when nothing was held back, and counts one in the singular", async () => {
    const { clock, out, say } = setup();
    for (let i = 0; i < 10; i++) say(i);
    await clock.advance(10_000);
    expect(out).toHaveLength(10);
    for (let i = 0; i < 11; i++) say(i);
    await clock.advance(10_000);
    expect(out.at(-1)).toEqual({
      kind: "notice",
      level: "warning",
      text: "1 more notice from extensions was not shown.",
      code: "notices_held_one",
    });
  });

  it("does not limit its own summary away, however many notices followed", async () => {
    const { clock, out, say } = setup();
    for (let i = 0; i < 10_000; i++) say(i);
    await clock.advance(10_000);
    expect(out).toHaveLength(11);
    expect(out[10]).toMatchObject({ text: "9990 more notices from extensions were not shown." });
  });

  it("stop() says what it held back, once, and leaves no timer", async () => {
    const { clock, out, limiter, say } = setup();
    for (let i = 0; i < 12; i++) say(i);
    limiter.stop();
    expect(out).toHaveLength(11);
    expect(out[10]).toEqual({
      kind: "notice",
      level: "warning",
      text: "2 more notices from extensions were not shown.",
      code: "notices_held_many",
      params: { count: "2" },
    });
    expect(clock.pending()).toBe(0);
    limiter.stop();
    await clock.advance(20_000);
    expect(out).toHaveLength(11);
  });

  it("stop() says nothing when nothing was held back", () => {
    const { out, limiter, say } = setup();
    for (let i = 0; i < 10; i++) say(i);
    limiter.stop();
    expect(out).toHaveLength(10);
  });
});
