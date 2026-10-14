import { describe, expect, it, vi } from "vitest";
import { type FdMaskTable, maskedStdio } from "./fd-mask.ts";

const BASE = ["pipe", "pipe", "pipe"] as const;

function table(links: Record<string, string>, openNull = vi.fn(() => 99)): FdMaskTable {
  return {
    readdir: () => Object.keys(links),
    readlink: (path) => links[path.split("/").pop() as string] as string,
    openNull,
  };
}

describe("maskedStdio (MC38)", () => {
  it("is dense: the master maps to /dev/null and every gap is ignored", () => {
    expect(
      maskedStdio(BASE, table({ "0": "/dev/null", "5": "/dev/ptmx", "7": "/dev/ptmx", "9": "/x" })),
    ).toEqual(["pipe", "pipe", "pipe", "ignore", "ignore", 99, "ignore", 99]);
  });

  it("masks any pty node, as the worker's closer does: a container's /dev/pts/ptmx and a slave", () => {
    expect(maskedStdio(BASE, table({ "3": "/dev/pts/ptmx", "4": "/dev/pts/3" }))).toEqual([
      "pipe",
      "pipe",
      "pipe",
      99,
      99,
    ]);
  });

  it("leaves the base alone without a master, or when /proc is unreadable", () => {
    const open = vi.fn(() => 99);
    expect(maskedStdio(BASE, table({ "4": "/dev/null", "6": "socket:[1]" }, open))).toEqual([...BASE]);
    expect(open).not.toHaveBeenCalled();
    const noProc: FdMaskTable = {
      readdir: () => {
        throw new Error("ENOENT");
      },
      readlink: () => "",
      openNull: open,
    };
    expect(maskedStdio(BASE, noProc)).toEqual([...BASE]);
  });
});
