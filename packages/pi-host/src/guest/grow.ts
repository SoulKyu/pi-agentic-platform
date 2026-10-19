/** Runs a fixed program with a fixed argv (never a shell) and returns its standard output. */
export type RunTool = (file: string, args: string[]) => Promise<string>;

const DEVICE = /^\/dev\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const numberAfter = (label: string, text: string): number => {
  const found = new RegExp(`^${label}:\\s+(\\d+)\\s*$`, "m").exec(text);
  if (!found) throw new Error(`the file system report is unreadable (${label})`);
  return Number(found[1]);
};

/**
 * R31, RT-14. The host only extends the sparse disk file; the guest grows its own file system at boot. When the block
 * device mounted at `root` is at least one block larger than the file system on it, runs `resize2fs <device>` and returns
 * true. `root` must itself be a mount point (`findmnt -M`): a process backend's temp folder is not, so a test host's own
 * disk is never resized. A source that is not a `/dev` path (an overlay, virtio-fs) is skipped. Rejects when a tool
 * fails: the guest logs it and goes on.
 */
export async function growFilesystem(options: { root: string; run: RunTool }): Promise<boolean> {
  const { root, run } = options;
  const device = (await run("findmnt", ["-no", "SOURCE", "-M", root])).trim();
  if (!DEVICE.test(device)) return false;
  const deviceBytes = Number((await run("blockdev", ["--getsize64", device])).trim());
  const report = await run("dumpe2fs", ["-h", device]);
  const blockSize = numberAfter("Block size", report);
  if (!Number.isFinite(deviceBytes)) throw new Error("the file system report is unreadable (device size)");
  if (deviceBytes - numberAfter("Block count", report) * blockSize < blockSize) return false;
  await run("resize2fs", [device]);
  return true;
}
