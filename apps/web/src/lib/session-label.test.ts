import { describe, expect, it } from "vitest";
import { basename, sessionLabel } from "./session-label.ts";

describe("sessionLabel (M4R88)", () => {
  it("prefers the name, then the preview, then the folder", () => {
    expect(sessionLabel({ name: "N", preview: "P", cwd: "/w/api" })).toBe("N");
    expect(sessionLabel({ name: null, preview: "P", cwd: "/w/api" })).toBe("P");
    expect(sessionLabel({ name: null, preview: null, cwd: "/w/api/" })).toBe("api");
    expect(sessionLabel({ name: null, cwd: "/w/api" })).toBe("api");
  });
  it("is empty when nothing is known", () => {
    expect(sessionLabel({ name: null, cwd: "/" })).toBe("");
    expect(sessionLabel(null)).toBe("");
  });
  it("takes the last folder of a path", () => {
    expect(basename("/w/api//")).toBe("api");
    expect(basename("/")).toBe("");
  });
});
