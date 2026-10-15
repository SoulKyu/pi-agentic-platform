import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { DISK_FLOOR_BYTES, localDiskFloor } from "./disk-floor.ts";

const stats =
  (bavail: number, bsize = 4096) =>
  () =>
    ({ bavail, bsize }) as never;

describe("localDiskFloor", () => {
  it("is 1 GiB", () => expect(DISK_FLOOR_BYTES).toBe(1024 ** 3));

  it("refuses with capacity under the floor, and lets the floor itself through", () => {
    expect(() => localDiskFloor("/x", stats(262_143))).toThrow(PapError);
    expect(() => localDiskFloor("/x", stats(262_143))).toThrow(expect.objectContaining({ code: "capacity" }));
    expect(() => localDiskFloor("/x", stats(262_144))).not.toThrow();
  });

  it("does not refuse when statfs cannot be read (M10: freeMb answers null)", () => {
    const failing = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(() => localDiskFloor("/x", failing)).not.toThrow();
  });

  it("measures the nearest folder that exists when the path does not yet", () => {
    const seen: string[] = [];
    const probe = (path: string) => {
      seen.push(path);
      if (path === "/pap/worktrees") throw Object.assign(new Error("none"), { code: "ENOENT" });
      return { bavail: 1, bsize: 1 } as never;
    };
    expect(() => localDiskFloor("/pap/worktrees", probe)).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    expect(seen).toEqual(["/pap/worktrees", "/pap"]);
  });
});
