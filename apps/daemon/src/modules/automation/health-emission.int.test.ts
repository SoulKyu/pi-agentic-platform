import { afterEach, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createHealthBuffer, createHealthEvents } from "../health/index.ts";
import { setup, state } from "./testing/feed-bed.ts";

afterEach(() => state.bed.dispose());

it("a feed that does not parse becomes a health event the owner can page (int)", async () => {
  const events = createHealthEvents(silentLogger);
  const { poll } = setup(() => Promise.resolve({ ok: false, code: "not_a_feed", retry: false }), {
    health: events,
  });
  const buffer = createHealthBuffer({ clock: state.bed.clock, logger: state.bed.logger });
  events.on((input) => buffer.record(input));
  const settlement = await poll();
  expect(settlement.outcome).toBe("fail"); // the emission never changed the settlement
  expect(buffer.page(state.bed.owner().userId).events[0]).toMatchObject({
    kind: "feed",
    code: "not_a_feed",
    severity: "err",
    count: 1,
  });
});
