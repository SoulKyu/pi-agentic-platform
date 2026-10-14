import { describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE, MAX_TABS } from "./model.ts";
import { parseWorkspace, serializeWorkspace } from "./persist.ts";

const tab = (id: string, extra = {}) => ({
  key: `session:${id}`,
  item: { kind: "session", id },
  split: null,
  ...extra,
});

describe("workspace persistence", () => {
  it("round-trips", () => {
    const ws = { tabs: [tab("a")], active: "session:a" };
    expect(parseWorkspace(serializeWorkspace(ws as never), false)).toEqual(ws);
  });

  it("drops a workspace of another version or shape", () => {
    for (const raw of [null, "{oops", '{"v":2,"tabs":[]}', '{"v":1,"tabs":"x"}', "[]"])
      expect(parseWorkspace(raw, false)).toEqual(EMPTY_WORKSPACE);
  });

  it("reports a rejected payload once, but not an absent one", () => {
    const rejected = vi.fn();
    parseWorkspace(null, false, rejected);
    expect(rejected).not.toHaveBeenCalled();
    for (const raw of ["{oops", '{"v":2,"tabs":[]}', "[]"]) parseWorkspace(raw, false, rejected);
    expect(rejected).toHaveBeenCalledTimes(3);
  });

  it("refuses an oversized payload without parsing it", () => {
    const rejected = vi.fn();
    const raw = JSON.stringify({ v: 1, active: null, tabs: [], pad: "x".repeat(200_000) });
    expect(parseWorkspace(raw, false, rejected)).toEqual(EMPTY_WORKSPACE);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("drops unknown or invalid tabs, duplicate keys and the gallery outside dev, caps the count, repairs active", () => {
    const raw = JSON.stringify({
      v: 1,
      active: "session:gone",
      tabs: [
        tab("a"),
        tab("a"),
        { key: "x", item: { kind: "teapot" }, split: null },
        { key: "dev-ui", item: { kind: "dev-ui" }, split: null },
        tab("b", { split: { item: { kind: "home" }, ratio: 7 } }),
        ...Array.from({ length: 30 }, (_, i) => tab(`n${i}`)),
      ],
    });
    const ws = parseWorkspace(raw, false);
    expect(ws.tabs).toHaveLength(MAX_TABS);
    expect(ws.tabs.slice(0, 2).map((t) => t.key)).toEqual(["session:a", "session:b"]);
    expect(ws.tabs[1]?.split?.ratio).toBe(0.85);
    expect(ws.active).toBe("session:a");
  });

  it("drops a tab whose key does not match its item, a bad id, and an invalid split", () => {
    const raw = JSON.stringify({
      v: 1,
      active: null,
      tabs: [
        { key: "session:other", item: { kind: "session", id: "a" }, split: null },
        { key: "session:", item: { kind: "session", id: "" }, split: null },
        tab("a/b"),
        tab("x".repeat(129)),
        { key: "settings", item: { kind: "settings", section: "nope" }, split: null },
        tab("ok", { split: { item: { kind: "teapot" }, ratio: 0.5 } }),
        tab("ok2", { split: { item: { kind: "home" }, ratio: "wide" } }),
        tab("ok3", { split: { item: { kind: "session", id: "ok3" }, ratio: 0.5 } }),
        tab("gal", { split: { item: { kind: "dev-ui" }, ratio: 0.5 } }),
      ],
    });
    const ws = parseWorkspace(raw, false);
    expect(ws.tabs.map((t) => [t.key, t.split])).toEqual([
      ["session:ok", null],
      ["session:ok2", null],
      ["session:ok3", null],
      ["session:gal", null],
    ]);
    expect(ws.active).toBe("session:ok");
  });

  it("keeps the gallery in dev builds", () => {
    const raw = JSON.stringify({
      v: 1,
      active: "dev-ui",
      tabs: [{ key: "dev-ui", item: { kind: "dev-ui" }, split: null }],
    });
    expect(parseWorkspace(raw, true).active).toBe("dev-ui");
  });

  it("drops lone-surrogate and dot ids, keeps the valid subset and reports", () => {
    const rejected = vi.fn();
    const raw = JSON.stringify({
      v: 1,
      active: "session:ok",
      tabs: [tab("\ud800"), tab("."), tab(".."), tab("ok")],
    });
    const ws = parseWorkspace(raw, false, rejected);
    expect(ws.tabs.map((t) => t.key)).toEqual(["session:ok"]);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("does not report a clean payload", () => {
    const rejected = vi.fn();
    parseWorkspace(serializeWorkspace({ tabs: [tab("a")], active: "session:a" } as never), false, rejected);
    expect(rejected).not.toHaveBeenCalled();
  });

  it("treats __proto__ and constructor as plain data", () => {
    const raw =
      '{"v":1,"active":"__proto__","tabs":[{"key":"__proto__","item":{"kind":"__proto__"},"split":null},{"key":"constructor","item":{"kind":"constructor"},"split":null},' +
      '{"key":"session:__proto__","item":{"kind":"session","id":"__proto__"},"split":{"item":{"kind":"constructor"},"ratio":0.5}},{"__proto__":{"kind":"home"},"key":"home"}]}';
    const ws = parseWorkspace(raw, false);
    expect(ws.tabs).toEqual([
      { key: "session:__proto__", item: { kind: "session", id: "__proto__" }, split: null },
    ]);
    expect(ws.active).toBe("session:__proto__");
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
  });
});

describe("workspace persistence of the M8 items", () => {
  const files = (root: string) => ({ key: `files:${root}`, item: { kind: "files", root }, split: null });
  const changes = (root: string) => ({
    key: `changes:${root}`,
    item: { kind: "changes", root },
    split: null,
  });
  const terminal = (id: string) => ({ key: `terminal:${id}`, item: { kind: "terminal", id }, split: null });
  const id = "AbCdEf0123456789_-AbCd";

  it("round-trips each kind, as a tab and as a split", () => {
    const ws = {
      tabs: [
        files("/w/a"),
        changes("/w/a"),
        terminal(id),
        tab("a", { split: { item: { kind: "changes", root: "/w/a" }, ratio: 0.4 } }),
      ],
      active: "terminal:" + id,
    };
    expect(parseWorkspace(serializeWorkspace(ws as never), false)).toEqual(ws);
  });

  it("drops a tab whose root is not canonical and absolute, or whose terminal id is malformed (M3's rule)", () => {
    const rejected = vi.fn();
    const raw = JSON.stringify({
      v: 1,
      tabs: [
        files("relative"),
        files("/a/../b"),
        changes("/a//b"),
        changes("/a/"),
        terminal("short"),
        files("/ok"),
      ],
      active: "files:/ok",
    });
    expect(parseWorkspace(raw, false, rejected).tabs.map((one) => one.key)).toEqual(["files:/ok"]);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("drops a split with an invalid root", () => {
    const raw = JSON.stringify({
      v: 1,
      tabs: [tab("a", { split: { item: { kind: "files", root: "x" }, ratio: 0.5 } })],
      active: "session:a",
    });
    expect(parseWorkspace(raw, false).tabs[0]?.split).toBeNull();
  });
});
