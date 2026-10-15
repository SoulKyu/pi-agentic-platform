import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, LAYOUT_KEY, MAX_LAYOUTS, readLayout, writeLayout } from "./lane-layout.ts";

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

describe("lane layout", () => {
  it("starts from the default", () => expect(readLayout("a-1a2b", memory())).toEqual(DEFAULT_LAYOUT));

  it("keeps the ratio, the right pane and the split per lane, across a reload", () => {
    const storage = memory();
    writeLayout("a-1a2b", { ratio: 0.3, right: "terminal", split: true }, storage);
    writeLayout("b-1a2b", { ratio: 0.6, right: "changes", split: false }, storage);
    expect(readLayout("a-1a2b", storage)).toEqual({ ratio: 0.3, right: "terminal", split: true });
    expect(readLayout("b-1a2b", storage)).toEqual({ ratio: 0.6, right: "changes", split: false });
    expect(storage.data.has(LAYOUT_KEY)).toBe(true);
    expect(LAYOUT_KEY).toBe("pap.lane-layout.v1");
  });

  it("drops the oldest lane when the 201st arrives", () => {
    const storage = memory();
    for (let i = 0; i <= MAX_LAYOUTS; i++)
      writeLayout(`l${i}-1a2b`, { ...DEFAULT_LAYOUT, ratio: 0.4 }, storage);
    expect(MAX_LAYOUTS).toBe(200);
    expect(readLayout("l0-1a2b", storage)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout("l1-1a2b", storage).ratio).toBe(0.4);
    expect(readLayout("l200-1a2b", storage).ratio).toBe(0.4);
    expect((JSON.parse(storage.data.get(LAYOUT_KEY) ?? "{}") as { lanes: unknown[] }).lanes).toHaveLength(
      200,
    );
  });

  it("a write refreshes the lane, so the least recently written goes first", () => {
    const storage = memory();
    for (let i = 0; i < MAX_LAYOUTS; i++) writeLayout(`l${i}-1a2b`, DEFAULT_LAYOUT, storage);
    writeLayout("l0-1a2b", { ...DEFAULT_LAYOUT, ratio: 0.7 }, storage);
    writeLayout("new-1a2b", DEFAULT_LAYOUT, storage);
    expect(readLayout("l0-1a2b", storage).ratio).toBe(0.7);
    expect(
      (JSON.parse(storage.data.get(LAYOUT_KEY) ?? "{}") as { lanes: Array<[string]> }).lanes.some(
        ([id]) => id === "l1-1a2b",
      ),
    ).toBe(false);
  });

  it.each([
    "not json",
    '{"v":2,"lanes":[]}',
    '{"v":1,"lanes":[["a-1a2b",{"ratio":9,"right":"x","split":1}]]}',
  ])("falls back to the default on %s", (stored) => {
    const storage = memory();
    storage.setItem(LAYOUT_KEY, stored);
    expect(readLayout("a-1a2b", storage)).toEqual(DEFAULT_LAYOUT);
  });

  it("survives a storage that refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLayout("a-1a2b", refusing)).toEqual(DEFAULT_LAYOUT);
    expect(() => writeLayout("a-1a2b", DEFAULT_LAYOUT, refusing)).not.toThrow();
  });
});
