import { describe, expect, it } from "vitest";
import { closeInheritedPtyFds } from "./close-pty-fds.ts";

const table = (links: Record<string, string>, failing: string[] = [], vanished: string[] = []) => {
  const closed: number[] = [];
  const lines: string[] = [];
  const count = closeInheritedPtyFds({
    readdir: () => Object.keys(links),
    readlink: (path) => {
      const name = path.split("/").at(-1) ?? "";
      const link = links[name];
      if (link === undefined || vanished.includes(name)) throw new Error("gone");
      return link;
    },
    close: (fd) => {
      if (failing.includes(String(fd))) throw new Error("EBADF");
      closed.push(fd);
    },
    log: (line) => void lines.push(line),
  });
  return { count, closed, lines };
};

describe("closeInheritedPtyFds (MC29)", () => {
  it("closes the pty masters and slaves from fd 3 up and nothing else, the IPC socket included", () => {
    const seen = table({
      "0": "/dev/pts/4",
      "1": "/dev/null",
      "3": "socket:[123]",
      "4": "/dev/ptmx",
      "5": "/dev/pts/9",
      "6": "/dev/pts",
      "7": "/tmp/dev/ptmx",
      "8": "/dev/ptmx (deleted)",
      "9": "pipe:[1]",
    });
    expect(seen.closed).toEqual([4, 5]);
    expect(seen.count).toBe(2);
    expect(seen.lines).toEqual(["pi-host: closed 2 inherited pty descriptor(s)"]);
  });

  it("skips a link that is gone, counts and logs a close that fails, and closes the others", () => {
    const seen = table({ "3": "/dev/ptmx", "4": "/dev/ptmx", "5": "/dev/ptmx" }, ["4"]);
    expect(seen.closed).toEqual([3, 5]);
    expect(seen.count).toBe(2);
    expect(seen.lines).toEqual([
      "pi-host: closed 2 inherited pty descriptor(s)",
      "pi-host: could not close 1 inherited pty descriptor(s)",
    ]);
    expect(table({ "3": "/dev/ptmx", "7": "gone" }, [], ["7"])).toMatchObject({
      closed: [3],
      lines: [expect.any(String)],
    });
  });

  it("says so, and closes nothing, without /proc; and stays silent without a pty descriptor", () => {
    const lines: string[] = [];
    const closed: number[] = [];
    const none = closeInheritedPtyFds({
      readdir: () => {
        throw new Error("ENOENT");
      },
      readlink: () => "/dev/ptmx",
      close: (fd) => void closed.push(fd),
      log: (line) => void lines.push(line),
    });
    expect([none, closed, lines]).toEqual([
      0,
      [],
      ["pi-host: pty descriptors not checked: /proc/self/fd is unreadable"],
    ]);
    expect(table({ "3": "socket:[1]" })).toMatchObject({ count: 0, closed: [], lines: [] });
  });
});
