import { describe, expect, it } from "vitest";
import { pathOfItem } from "./item-path.ts";
import { itemKey, type ItemRef } from "./model.ts";
import { parseWorkspace, serializeWorkspace } from "./persist.ts";

const BOX = "project:0b8f6f6e-1111-4222-8333-444455556666";
const preview = (box: string, name: string): ItemRef => ({ kind: "preview", box, name });
const stored = (item: unknown, key: string) =>
  JSON.stringify({ v: 1, tabs: [{ key, item, split: null }], active: key });

describe("the preview item kind", () => {
  it("keys on the box and the name", () => {
    expect(itemKey(preview(BOX, "web"))).toBe(`preview:${BOX}/web`);
    expect(itemKey(preview("agent:atlas-1a2b", "api"))).toBe("preview:agent:atlas-1a2b/api");
  });

  it("is not addressable: its path is the home", () => {
    expect(pathOfItem(preview(BOX, "web"))).toBe("/");
  });

  it("survives a round trip through storage, as a tab and as a split", () => {
    const tab = { key: "session:s1", item: { kind: "session", id: "s1" } as ItemRef, split: null };
    const ws = {
      tabs: [{ ...tab, split: { item: preview(BOX, "web"), ratio: 0.5 } }],
      active: "session:s1",
    };
    expect(parseWorkspace(serializeWorkspace(ws), false)).toEqual(ws);
  });

  it.each([
    ["a bad box", preview("host:thing", "web")],
    ["an empty box", preview("", "web")],
    ["a box with a bad agent id", preview("agent:Atlas", "web")],
    ["a bad name", preview(BOX, "Web App")],
    ["an empty name", preview(BOX, "")],
    ["a name with a slash", preview(BOX, "a/b")],
    ["a name of 33 characters", preview(BOX, "a".repeat(33))],
  ])("drops a persisted item with %s", (_name, item) => {
    let rejected = false;
    const ws = parseWorkspace(stored(item, itemKey(item)), false, () => {
      rejected = true;
    });
    expect(ws.tabs).toEqual([]);
    expect(rejected).toBe(true);
  });

  it("drops an item whose key does not match its content", () => {
    expect(parseWorkspace(stored(preview(BOX, "web"), "preview:other"), false).tabs).toEqual([]);
  });
});
