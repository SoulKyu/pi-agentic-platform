import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { BoxRef } from "@pap/contracts";
import { sameBox } from "./box-name.ts";
import { mkfsArgv } from "./argv.ts";
import { VmdFailure } from "./errors.ts";
import type { Exec, OpsDeps } from "./ops.ts";
import type { VmEntry } from "./ops-vm.ts";

const MIB = 1024 * 1024;
const MKFS_TIMEOUT_MS = 10 * 60_000;
/** The most a home can be (AgentResources' ceiling), and the floor of a new disk. */

type BoxDisk = { box: BoxRef; taskKey: null };
type Sized = BoxDisk & { diskMb: number };
type Delete = { box: BoxRef; taskKey: string | null; purge: boolean };

const { O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

export function fileExists(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function folderExists(folder: string): boolean {
  try {
    return lstatSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The folder is made here (0700) and must be a folder of pap-vmd's, never a link. */
function ensureFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory()) throw new VmdFailure("failed");
}

/** A task's disk lives alone in `tasks/<key>/`: the folder goes with it. */
export function removeTaskDir(disk: string): void {
  rmSync(path.dirname(disk), { recursive: true, force: true });
}

/** A new sparse file of `mb` MiB (O_EXCL: never an existing file, never through a link), 0600. */
function createSparse(file: string, mb: number): void {
  ensureFolder(path.dirname(file));
  const fd = openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    ftruncateSync(fd, mb * MIB);
  } finally {
    closeSync(fd);
  }
}

/** R31: `mkfs.ext4` runs only on a file pap-vmd has just made. On any failure the file is removed. */
export async function makeBlankDisk(exec: Exec, file: string, mb: number): Promise<void> {
  try {
    createSparse(file, mb);
    const result = await exec(mkfsArgv(file), { timeoutMs: MKFS_TIMEOUT_MS });
    if (result.code !== 0) throw new VmdFailure("failed");
  } catch (error) {
    rmSync(file, { force: true });
    throw error instanceof VmdFailure ? error : new VmdFailure("failed");
  }
}

export function createDiskOps(deps: OpsDeps, list: () => Promise<VmEntry[]>) {
  const { exec, state, locks, clock, room } = deps;

  async function boxIsRunning(box: BoxRef, taskKey?: string): Promise<boolean> {
    const vms = await list();
    return vms.some(
      (vm) =>
        sameBox(vm.box, box) && vm.state !== "stopped" && (taskKey === undefined || vm.taskKey === taskKey),
    );
  }

  function create(request: Sized): Promise<unknown> {
    return locks.withBox(request.box, async () => {
      const file = state.diskPath(request.box, null);
      if (fileExists(file)) throw new VmdFailure("conflict");
      await room(request.diskMb);
      await makeBlankDisk(exec, file, request.diskMb);
      return { diskMb: request.diskMb };
    });
  }

  /** R31: the file only gets longer; the guest grows its file system itself at its next boot. */
  function grow(request: Sized): Promise<unknown> {
    return locks.withBox(request.box, async () => {
      const file = state.diskPath(request.box, null);
      if (!fileExists(file)) throw new VmdFailure("not_found");
      if (await boxIsRunning(request.box)) throw new VmdFailure("conflict");
      const target = request.diskMb * MIB;
      let fd: number;
      try {
        fd = openSync(file, O_RDWR | O_NOFOLLOW);
      } catch {
        throw new VmdFailure("failed");
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new VmdFailure("failed");
        if (target < stat.size) throw new VmdFailure("bad_request");
        if (target > stat.size) {
          await room(Math.ceil((target - stat.size) / MIB));
          ftruncateSync(fd, target);
        }
      } finally {
        closeSync(fd);
      }
      return { diskMb: request.diskMb };
    });
  }

  function remove(request: Delete): Promise<unknown> {
    return locks.withBox(request.box, async () => {
      if (request.taskKey !== null) {
        if (await boxIsRunning(request.box, request.taskKey)) throw new VmdFailure("conflict");
        const disk = state.diskPath(request.box, request.taskKey);
        if (!folderExists(path.dirname(disk))) throw new VmdFailure("not_found");
        removeTaskDir(disk);
        return { deleted: true };
      }
      const folder = state.boxDir(request.box);
      if (!folderExists(folder)) throw new VmdFailure("not_found");
      // R30: never while any VM of the box runs (the box's disk may be attached).
      if (await boxIsRunning(request.box)) throw new VmdFailure("conflict");
      if (request.purge) rmSync(folder, { recursive: true, force: true });
      else renameSync(folder, state.trashPath(request.box, clock.now()));
      return { deleted: true };
    });
  }

  return { create, grow, remove };
}
