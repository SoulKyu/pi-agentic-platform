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
});
