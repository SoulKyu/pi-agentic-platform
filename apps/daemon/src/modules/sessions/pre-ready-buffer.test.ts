import { describe, expect, it } from "vitest";
import {
  createPreReadyBuffer,
  MAX_PRE_READY_BYTES,
  MAX_PRE_READY_EVENTS,
  type PreReadyItem,
} from "./pre-ready-buffer.ts";

const notice = (text: string): PreReadyItem => ({
  kind: "publish",
  event: { kind: "notice", level: "warning", text },
});

describe("createPreReadyBuffer", () => {
  it("keeps items in the order they came, events and journal lines together", () => {
    const buffer = createPreReadyBuffer();
    const record: PreReadyItem = { kind: "record", recordKind: "policy", data: { tool: "bash" } };
    buffer.add(notice("a"));
    buffer.add(record);
    buffer.add(notice("b"));
    expect(buffer.drain()).toEqual({ items: [notice("a"), record, notice("b")], dropped: 0 });
  });

  it("holds the earliest items and counts the ones past the item cap", () => {
    const buffer = createPreReadyBuffer();
    for (let n = 0; n < MAX_PRE_READY_EVENTS + 5; n++) buffer.add(notice(`n${n}`));
    const { items, dropped } = buffer.drain();
    expect(items).toHaveLength(MAX_PRE_READY_EVENTS);
    expect(items[0]).toEqual(notice("n0"));
    expect(dropped).toBe(5);
  });

  it("holds back an item that would pass the byte cap, but still takes a smaller one after it", () => {
    const buffer = createPreReadyBuffer();
    buffer.add(notice("x".repeat(MAX_PRE_READY_BYTES - 1000)));
    buffer.add(notice("y".repeat(2000)));
    buffer.add(notice("small"));
    const { items, dropped } = buffer.drain();
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual(notice("small"));
    expect(dropped).toBe(1);
  });
});
