import { describe, expect, it } from "vitest";
import { itemFromPath, pathOfItem } from "./item-path.ts";

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
});
