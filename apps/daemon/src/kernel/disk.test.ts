import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDiskGuard, createPathDiskGuard, diskFloor, freeMb } from "./disk.ts";
import type { Logger } from "./logger.ts";

const MB = 1_048_576;
const free = (mb: number) => () => ({ bavail: mb, bsize: MB });
const failing = () => {
  throw new Error("statfs failed");
};
const spyLogger = () => {
  const warn = vi.fn();
  const logger: Logger = { debug: () => {}, info: () => {}, warn, error: () => {}, child: () => logger };
  return { logger, warn };
};

describe("freeMb", () => {
  it("is the available blocks times the block size, in whole megabytes", () => {
    expect(freeMb("/x", () => ({ bavail: 3000, bsize: 4096 }))).toBe(11);
  });

  it("is null when statfs fails", () => {
    expect(freeMb("/x", failing)).toBeNull();
  });

  it("measures the nearest existing parent of a folder that is not there yet", () => {
    const seen: string[] = [];
    const statfs = (path: string) => {
      seen.push(path);
      if (path !== "/a") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { bavail: 7, bsize: MB };
    };
    expect(freeMb("/a/b/c", statfs)).toBe(7);
    expect(seen).toEqual(["/a/b/c", "/a/b", "/a"]);
  });
});

describe("diskFloor", () => {
  it("refuses below the floor, with the free figure", () => {
    expect(diskFloor("/x", 1024, free(100))).toEqual({ ok: false, freeMb: 100 });
  });

  it("passes at the floor and above it", () => {
    expect(diskFloor("/x", 1024, free(1024))).toEqual({ ok: true });
    expect(diskFloor("/x", 1024, free(5000))).toEqual({ ok: true });
  });

  it("never refuses with a floor of 0, and never asks statfs", () => {
    const statfs = vi.fn(free(0));
    expect(diskFloor("/x", 0, statfs)).toEqual({ ok: true });
    expect(statfs).not.toHaveBeenCalled();
  });

  it("lets the action through when statfs fails", () => {
    expect(diskFloor("/x", 1024, failing)).toEqual({ ok: true });
  });
});

describe("createDiskGuard", () => {
  it("throws disk_low below the floor", () => {
    const { logger } = spyLogger();
    const guard = createDiskGuard({ path: "/x", floorMb: 1024, logger, statfs: free(10) });
    expect(() => guard()).toThrow(PapError);
    try {
      guard();
    } catch (error) {
      expect((error as PapError).code).toBe("disk_low");
    }
  });

  it("allows and logs once when statfs throws", () => {
    const { logger, warn } = spyLogger();
    const guard = createDiskGuard({ path: "/x", floorMb: 1024, logger, statfs: failing });
    guard();
    guard();
    guard();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("disk_free_unknown", expect.any(Object));
  });

  it("is off with a floor of 0", () => {
    const { logger } = spyLogger();
    expect(() => createDiskGuard({ path: "/x", floorMb: 0, logger, statfs: free(0) })()).not.toThrow();
  });
});

describe("createPathDiskGuard (the lanes seam, M9R117)", () => {
  it("checks the path it is given each time and throws disk_low below the floor", () => {
    const { logger, warn } = spyLogger();
    const seen: string[] = [];
    const statfs = (path: string) => {
      seen.push(path);
      return { bavail: path === "/full" ? 10 : 5000, bsize: MB };
    };
    const guard = createPathDiskGuard({ floorMb: 1024, logger, statfs });
    expect(guard("/roomy")).toBeUndefined();
    expect(() => guard("/full")).toThrow(new PapError("disk_low"));
    expect(seen).toEqual(["/roomy", "/full"]);
    expect(warn).toHaveBeenCalledWith("disk_low", { freeMb: 10, floorMb: 1024 });
  });

  it("is off with a floor of 0 (PAP_MIN_FREE_DISK_MB=0) and never asks statfs", () => {
    const { logger } = spyLogger();
    const statfs = vi.fn(free(0));
    expect(createPathDiskGuard({ floorMb: 0, logger, statfs })("/x")).toBeUndefined();
    expect(statfs).not.toHaveBeenCalled();
  });

  it("lets the action through when statfs fails, and logs it once", () => {
    const { logger, warn } = spyLogger();
    const guard = createPathDiskGuard({ floorMb: 1024, logger, statfs: failing });
    expect(guard("/x")).toBeUndefined();
    expect(guard("/y")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
