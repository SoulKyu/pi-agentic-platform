import { describe, expect, it } from "vitest";
import { growFilesystem } from "./grow.ts";

const GIB = 1024 ** 3;
type Run = (file: string, args: string[]) => Promise<string>;

function fakeRun(options: { source?: string; device: number; blocks: number; blockSize?: number }) {
  const calls: Array<[string, string[]]> = [];
  const run: Run = (file, args) => {
    calls.push([file, args]);
    if (file === "findmnt") return Promise.resolve(`${options.source ?? "/dev/vda"}\n`);
    if (file === "blockdev") return Promise.resolve(`${options.device}\n`);
    if (file === "dumpe2fs") {
      return Promise.resolve(
        `Filesystem volume name:   <none>\nBlock count:              ${options.blocks}\nBlock size:               ${options.blockSize ?? 4096}\n`,
      );
    }
    return Promise.resolve("");
  };
  return { run, calls };
}

describe("growFilesystem", () => {
  it("runs resize2fs with the device when the device is larger than the file system", async () => {
    const { run, calls } = fakeRun({ device: 2 * GIB, blocks: GIB / 4096 });
    await expect(growFilesystem({ root: "/agent", run })).resolves.toBe(true);
    expect(calls[0]).toEqual(["findmnt", ["-no", "SOURCE", "-M", "/agent"]]);
    expect(calls.at(-1)).toEqual(["resize2fs", ["/dev/vda"]]);
  });

  it("does nothing when the file system fills the device", async () => {
    const { run, calls } = fakeRun({ device: GIB, blocks: GIB / 4096 });
    await expect(growFilesystem({ root: "/agent", run })).resolves.toBe(false);
    expect(calls.some(([file]) => file === "resize2fs")).toBe(false);
  });

  it("does nothing for less than one block of slack", async () => {
    const { run, calls } = fakeRun({ device: GIB + 4095, blocks: GIB / 4096 });
    await expect(growFilesystem({ root: "/agent", run })).resolves.toBe(false);
    expect(calls.some(([file]) => file === "resize2fs")).toBe(false);
  });

  // Mutant: pass whatever findmnt printed to resize2fs -> a source that is not a /dev path is refused (killed here).
  it("skips a source that is not a block device path", async () => {
    for (const source of ["overlay", "virtiofs", "/dev/../etc/x", "-f", "/dev/vda; reboot"]) {
      const { run, calls } = fakeRun({ source, device: 2 * GIB, blocks: GIB / 4096 });
      await expect(growFilesystem({ root: "/agent", run })).resolves.toBe(false);
      expect(calls.map(([file]) => file)).toEqual(["findmnt"]);
    }
  });

  it("rejects when a tool fails or its output cannot be read", async () => {
    await expect(
      growFilesystem({ root: "/agent", run: () => Promise.reject(new Error("no findmnt")) }),
    ).rejects.toThrow(/no findmnt/);
    const garbled: Run = (file) => Promise.resolve(file === "findmnt" ? "/dev/vda\n" : "nothing useful");
    await expect(growFilesystem({ root: "/agent", run: garbled })).rejects.toThrow(/unreadable/);
  });

  /*
   * T20a: under Kata the container's /dev has no usable node for the disk (`findmnt` says /dev/vdb; the file is not there, and a node
   * made with mknod is refused by the guest's device cgroup), so the file system never grew. The kernel's own online resize
   * (EXT4_IOC_RESIZE_FS on the mount point, CAP_SYS_RESOURCE) needs no node: the size comes from /sys/class/block.
   * Mutants: ioctl never run -> "grows through the mount point"; sectors not validated -> "refuses"; run when it fits -> "does nothing".
   */
  describe("a disk without a node in /dev", () => {
    const fs = (sectors: string) => ({ exists: () => false, sectors: () => sectors });
    function runner(statOut: string) {
      const calls: Array<[string, string[]]> = [];
      const run: Run = (file, args) => {
        calls.push([file, args]);
        return Promise.resolve(file === "findmnt" ? "/dev/vdb\n" : file === "stat" ? statOut : "");
      };
      return { run, calls };
    }

    it("grows through the mount point to the device's size in file system blocks", async () => {
      const { run, calls } = runner("4096 262144\n");
      // 2 GiB device = 4194304 sectors = 524288 blocks of 4096.
      await expect(growFilesystem({ root: "/agent", run, node: fs("4194304\n") })).resolves.toBe(true);
      expect(calls).toContainEqual(["stat", ["-f", "-c", "%S %b", "/agent"]]);
      const last = calls.at(-1) as [string, string[]];
      expect(last[0]).toBe("python3");
      expect(last[1].slice(-2)).toEqual(["/agent", "524288"]);
      expect(calls.some(([file]) => file === "resize2fs" || file === "mknod")).toBe(false);
    });

    it("does nothing when the file system fills the device", async () => {
      const { run, calls } = runner("4096 524288\n");
      await expect(growFilesystem({ root: "/agent", run, node: fs("4194304") })).resolves.toBe(false);
      expect(calls.some(([file]) => file === "python3")).toBe(false);
    });

    it("refuses a sector count that is not a number, and a tool that fails", async () => {
      for (const sectors of ["", "abc", "-5", "0", "1e9"]) {
        const { run, calls } = runner("4096 262144\n");
        await expect(growFilesystem({ root: "/agent", run, node: fs(sectors) })).rejects.toThrow(
          /unreadable/,
        );
        expect(calls.some(([file]) => file === "python3")).toBe(false);
      }
      const failing: Run = (file) =>
        file === "python3"
          ? Promise.reject(new Error("EPERM"))
          : Promise.resolve(file === "findmnt" ? "/dev/vdb\n" : "4096 262144\n");
      await expect(growFilesystem({ root: "/agent", run: failing, node: fs("4194304") })).rejects.toThrow(
        /EPERM/,
      );
    });
  });
});
