import { describe, expect, it } from "vitest";
import { isValidId, itemFromPath, MAX_ID, pathOfItem } from "./item-path.ts";

describe("item ↔ path", () => {
  it.each([
    ["/", { kind: "home" }],
    ["/s/abc", { kind: "session", id: "abc" }],
    ["/s/a%20b", { kind: "session", id: "a b" }],
    ["/settings", { kind: "settings", section: "appearance" }],
    ["/settings/", { kind: "settings", section: "appearance" }],
    ["/settings/shortcuts", { kind: "settings", section: "shortcuts" }],
  ])("%s", (path, item) => {
    expect(itemFromPath(path, false)).toEqual(item);
  });

  it.each([
    "/s/",
    "/s/a/b",
    `/s/${"x".repeat(129)}`,
    "/s/%E0%A4%A",
    "/s/a%2Fb",
    "/s/..",
    "/s/.",
    "/s/%2e%2e",
    "/s/%2E",
    "/s/%ED%A0%80",
    "/settings/unknown",
    "/nope",
    "/dev/ui",
  ])("%s is not found", (path) => {
    expect(itemFromPath(path, false)).toBeNull();
  });

  it("knows /dev/ui only where the gallery exists, and round-trips every item", () => {
    expect(itemFromPath("/dev/ui", true)).toEqual({ kind: "dev-ui" });
    for (const path of ["/", "/s/a%20b", "/settings/language", "/dev/ui"])
      expect(pathOfItem(itemFromPath(path, true) as never)).toBe(path);
  });

  it("round-trips ids with spaces, unicode and percent signs", () => {
    for (const id of ["a b", "é日本", "100%", "a%2Fb", "😀", "__proto__", "constructor"]) {
      const path = pathOfItem({ kind: "session", id });
      expect(itemFromPath(path, false)).toEqual({ kind: "session", id });
      expect(pathOfItem(itemFromPath(path, false) as never)).toBe(path);
    }
  });

  it("validates ids and keeps pathOfItem total", () => {
    for (const id of ["", ".", "..", "a/b", "\ud800", "a\udc00b", "x".repeat(MAX_ID + 1)]) {
      expect(isValidId(id)).toBe(false);
      expect(() => pathOfItem({ kind: "session", id })).not.toThrow();
      expect(itemFromPath(pathOfItem({ kind: "session", id }), false)).toEqual({ kind: "home" });
    }
    for (const id of ["a", "...", "x".repeat(MAX_ID), "😀"]) expect(isValidId(id)).toBe(true);
  });

  it("refuses a long id made of many escapes without throwing", () => {
    expect(itemFromPath(`/s/${"%41".repeat(10_000)}`, false)).toBeNull();
    expect(itemFromPath(`/s/${"%41".repeat(MAX_ID)}`, false)).toEqual({
      kind: "session",
      id: "A".repeat(MAX_ID),
    });
  });
});
