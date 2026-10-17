import { describe, expect, it } from "vitest";
import { renderJson, renderText } from "./render.ts";
import type { DoctorReport } from "./types.ts";

const report: DoctorReport = {
  exit: 1,
  results: [
    { id: "node", title: "Node", status: "ok", detail: "v24.14.0" },
    {
      id: "toolchain",
      title: "Toolchain",
      status: "info",
      detail: "missing g++",
      fix: "sudo apt install g++",
    },
    { id: "linger", title: "Linger", status: "warn", detail: "off", fix: "loginctl enable-linger" },
    { id: "disk", title: "Disk", status: "fail", detail: "low", fix: "free space" },
    { id: "journal", title: "Journal", status: "skip", detail: "not applicable in a container" },
  ],
};

describe("renderText", () => {
  it("one line per check, a fix line after each non-ok result that has one", () => {
    expect(renderText(report).split("\n")).toEqual([
      "[ok] node v24.14.0",
      "[info] toolchain missing g++",
      "  fix: sudo apt install g++",
      "[warn] linger off",
      "  fix: loginctl enable-linger",
      "[fail] disk low",
      "  fix: free space",
      "[skip] journal not applicable in a container",
      "",
    ]);
  });

  it("never prints a control character or an escape sequence from a detail", () => {
    const text = renderText({
      exit: 0,
      results: [{ id: "x", title: "t", status: "ok", detail: "a\u001b[31mred\u0007\nnext" }],
    });
    expect(text).toBe("[ok] x a?[31mred??next\n");
  });
});

describe("renderJson", () => {
  it("is valid JSON with the same fields and no ANSI", () => {
    const text = renderJson({
      ...report,
      results: [{ id: "x", title: "t", status: "warn", detail: "\u001b[31mred", fix: "f" }],
    });
    expect(text).not.toContain("\u001b");
    expect(JSON.parse(text)).toEqual({
      exit: 1,
      results: [{ id: "x", title: "t", status: "warn", detail: "\u001b[31mred", fix: "f" }],
    });
    expect(text.endsWith("\n")).toBe(true);
  });
});
