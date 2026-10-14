import { describe, expect, it } from "vitest";
import { decodeRoot, encodeRoot, isValidId, itemFromPath, MAX_ID, pathOfItem } from "./item-path.ts";

describe("item ↔ path", () => {
  it.each([
    ["/", { kind: "home" }],
    ["/s/abc", { kind: "session", id: "abc" }],
    ["/s/a%20b", { kind: "session", id: "a b" }],
    ["/settings", { kind: "settings", section: "appearance" }],
    ["/settings/", { kind: "settings", section: "appearance" }],
    ["/settings/shortcuts", { kind: "settings", section: "shortcuts" }],
    // The model menu and the composer pill link here (M7 Task 9): it was a dead path before the section existed.
    ["/settings/models", { kind: "settings", section: "models" }],
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
    for (const path of ["/", "/s/a%20b", "/settings/language", "/settings/models", "/dev/ui"])
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

const TERMINAL = "AbCdEf0123456789_-AbCd";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("files, changes and terminal items (M8R71)", () => {
  const roots = ["/home/u/my proj", "/srv/\u00e9t\u00e9/app.v2", "/", "/w/\u65e5\u672c/\ud83d\ude00"];

  it("round-trips each kind, and every path is one plain segment", () => {
    for (const root of roots) {
      for (const kind of ["files", "changes"] as const) {
        const path = pathOfItem({ kind, root });
        expect(path).toMatch(/^\/(explore|changes)\/[A-Za-z0-9_-]+$/);
        expect(itemFromPath(path, false)).toEqual({ kind, root });
      }
    }
    expect(pathOfItem({ kind: "files", root: "/home/u/my proj" })).toBe(`/explore/${b64("/home/u/my proj")}`);
    const term = pathOfItem({ kind: "terminal", id: TERMINAL });
    expect(term).toBe(`/term/${TERMINAL}`);
    expect(itemFromPath(term, false)).toEqual({ kind: "terminal", id: TERMINAL });
  });

  it("encodes and decodes a root, and refuses what is not canonical", () => {
    for (const root of roots) expect(decodeRoot(encodeRoot(root))).toBe(root);
    for (const bad of ["a/b", "/a/../b", "/a//b", "/a/./b", "/a/", "", "/a\0b"])
      expect(decodeRoot(b64(bad)), bad).toBeNull();
    for (const segment of ["!!!", "a", "a=", "%2F", "", "Lw=="])
      expect(decodeRoot(segment), segment).toBeNull();
    expect(decodeRoot(Buffer.from([0xff, 0xfe]).toString("base64url"))).toBeNull(); // not UTF-8
    expect(decodeRoot("Lx")).toBeNull(); // trailing bits set: a second spelling of "/"
  });

  it("refuses a bad segment in the URL, and /files/x is not an item path", () => {
    for (const path of [
      `/explore/${b64("a/b")}`,
      `/changes/${b64("/a/../b")}`,
      `/explore/${b64("/a//b")}`,
      "/explore/!!",
      "/explore/",
      "/explore/a/b",
      `/explore/${encodeRoot("/a")}%2F`,
      "/term/short",
      `/term/${TERMINAL}x`,
      "/term/",
      "/files/x",
      "/files/L2E",
    ])
      expect(itemFromPath(path, false), path).toBeNull();
  });

  it("keeps pathOfItem total on an invalid root or terminal id", () => {
    expect(pathOfItem({ kind: "files", root: "relative" })).toBe("/");
    expect(pathOfItem({ kind: "changes", root: "/a/../b" })).toBe("/");
    expect(pathOfItem({ kind: "terminal", id: "nope" })).toBe("/");
  });
});
