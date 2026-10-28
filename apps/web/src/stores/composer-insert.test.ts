import { beforeEach, describe, expect, it } from "vitest";
import { useComposerInsert } from "./composer-insert.ts";

beforeEach(() => useComposerInsert.getState().reset());

describe("useComposerInsert", () => {
  it("push and take once; a second push before the take joins with a blank line; reset", () => {
    const store = useComposerInsert.getState();
    store.push("s1", "> a\n\n");
    const first = useComposerInsert.getState().items["s1"]?.n;
    store.push("s1", "> b\n\n");
    const second = useComposerInsert.getState().items["s1"];
    expect(second?.text).toBe("> a\n\n> b\n\n");
    expect(second?.n).toBeGreaterThan(first ?? 0);
    expect(useComposerInsert.getState().take("s1")).toBe("> a\n\n> b\n\n");
    expect(useComposerInsert.getState().take("s1")).toBeNull();
    store.push("s2", "x");
    store.reset();
    expect(useComposerInsert.getState().items).toEqual({});
  });
});
