import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createHelperFeed } from "./status-feed.ts";

const status = (active: number, waiting = 0) => ({ active, max: 4, waiting });

describe("the helper feed", () => {
  it("sends at most once a second, only on change, with the latest counts", async () => {
    const clock = createFakeClock();
    const sent: unknown[] = [];
    const feed = createHelperFeed({ clock, send: (s) => sent.push(s) });
    feed.push(status(1));
    feed.push(status(2));
    feed.push(status(3, 1));
    expect(sent).toEqual([status(1)]);
    await clock.advance(999);
    expect(sent).toHaveLength(1);
    await clock.advance(1);
    expect(sent).toEqual([status(1), status(3, 1)]);
    feed.push(status(1));
    feed.push(status(3, 1));
    await clock.advance(1000);
    expect(sent).toHaveLength(2);
    expect(clock.pending()).toBe(0);
  });
});
