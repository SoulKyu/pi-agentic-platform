/** Runs a fixed program with a fixed argv (never a shell) and returns its standard output. */
export type RunTool = (file: string, args: string[]) => Promise<string>;

const DEVICE = /^\/dev\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The sysfs seam for a disk the container's /dev has no node for; absent, the device path is trusted as it is. */
export interface DeviceSysfs {
  exists(path: string): boolean;
  /** The disk's size in 512-byte sectors, from `/sys/class/block/<name>/size`. */
  sectors(name: string): string;
}

/** EXT4_IOC_RESIZE_FS on the mount point: the kernel grows the mounted file system to `blocks`; no device node is opened. */
const RESIZE_SCRIPT =
  "import fcntl, os, struct, sys\nfd = os.open(sys.argv[1], os.O_RDONLY)\nfcntl.ioctl(fd, 0x40086610, struct.pack('Q', int(sys.argv[2])))\n";

const numberAfter = (label: string, text: string): number => {
  const found = new RegExp(`^${label}:\\s+(\\d+)\\s*$`, "m").exec(text);
  if (!found) throw new Error(`the file system report is unreadable (${label})`);
  return Number(found[1]);
};

/**
 * R31, RT-14. The host only extends the sparse disk file; the guest grows its own file system at boot. When the block
 * device mounted at `root` is at least one block larger than the file system on it, grows it and returns true. `root` must
 * itself be a mount point (`findmnt -M`): a process backend's temp folder is not, so a test host's own disk is never
 * resized. A source that is not a `/dev` path (an overlay, virtio-fs) is skipped. With a device node (`resize2fs <device>`);
 * under Kata the container has none usable (T20a), so the kernel resizes through the mount point, sized from sysfs.
 * Rejects when a tool fails: the guest logs it and goes on.
 */
export async function growFilesystem(options: {
  root: string;
  run: RunTool;
  node?: DeviceSysfs;
}): Promise<boolean> {
  const { root, run, node } = options;
  const device = (await run("findmnt", ["-no", "SOURCE", "-M", root])).trim();
  if (!DEVICE.test(device)) return false;
  if (node === undefined || node.exists(device)) return resizeIfSmaller(run, device);
  const sectors = node.sectors(device.slice(device.lastIndexOf("/") + 1)).trim();
  if (!/^[1-9]\d{0,15}$/.test(sectors)) throw new Error("the file system report is unreadable (device size)");
  const stat = /^(\d+) (\d+)$/.exec((await run("stat", ["-f", "-c", "%S %b", root])).trim());
  if (!stat) throw new Error("the file system report is unreadable (stat)");
  const blockSize = Number(stat[1]);
  const wanted = Math.floor((Number(sectors) * 512) / blockSize);
  if (wanted <= Number(stat[2])) return false;
  await run("python3", ["-c", RESIZE_SCRIPT, root, String(wanted)]);
  return true;
}

async function resizeIfSmaller(run: RunTool, device: string): Promise<boolean> {
  const deviceBytes = Number((await run("blockdev", ["--getsize64", device])).trim());
  const report = await run("dumpe2fs", ["-h", device]);
  const blockSize = numberAfter("Block size", report);
  if (!Number.isFinite(deviceBytes)) throw new Error("the file system report is unreadable (device size)");
  if (deviceBytes - numberAfter("Block count", report) * blockSize < blockSize) return false;
  await run("resize2fs", [device]);
  return true;
}
