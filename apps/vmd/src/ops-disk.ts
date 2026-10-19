import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { mkfsArgv } from "./argv.ts";
import { VmdFailure } from "./errors.ts";
import type { Exec, OpsDeps } from "./ops.ts";
import type { VmEntry } from "./ops-vm.ts";
import { copyTreeSafely } from "./safe-tree.ts";

const MIB = 1024 * 1024;
const MKFS_TIMEOUT_MS = 10 * 60_000;
/** The most a migrated home can be (AgentResources' ceiling), and the floor of a new disk. */
const POPULATE_MAX_MB = 65_536;
const POPULATE_MIN_MB = 1024;
const POPULATE_MAX_ENTRIES = 500_000;

type AgentDisk = { agentId: string; taskKey: null };
type Sized = AgentDisk & { diskMb: number };
type Delete = { agentId: string; taskKey: string | null; purge: boolean };

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
export async function makeBlankDisk(
  exec: Exec,
  file: string,
  mb: number,
  populateFrom?: string,
): Promise<void> {
  try {
    createSparse(file, mb);
    const result = await exec(mkfsArgv(file, populateFrom), { timeoutMs: MKFS_TIMEOUT_MS });
    if (result.code !== 0) throw new VmdFailure("failed");
  } catch (error) {
    rmSync(file, { force: true });
    throw error instanceof VmdFailure ? error : new VmdFailure("failed");
  }
}

function treeMiB(folder: string): number {
  let bytes = 0;
  for (const name of readdirSync(folder)) {
    const entry = lstatSync(path.join(folder, name));
    if (entry.isDirectory()) bytes += treeMiB(path.join(folder, name)) * MIB;
    else bytes += entry.size;
  }
  return Math.ceil(bytes / MIB);
}

export function createDiskOps(deps: OpsDeps, list: () => Promise<VmEntry[]>) {
  const { exec, state, locks, clock, room } = deps;

  async function agentIsRunning(agentId: string, taskKey?: string): Promise<boolean> {
    const vms = await list();
    return vms.some(
      (vm) =>
        vm.agentId === agentId && vm.state !== "stopped" && (taskKey === undefined || vm.taskKey === taskKey),
    );
  }

  function create(request: Sized): Promise<unknown> {
    return locks.withAgent(request.agentId, async () => {
      const file = state.diskPath(request.agentId, null);
      if (fileExists(file)) throw new VmdFailure("conflict");
      await room(request.diskMb);
      await makeBlankDisk(exec, file, request.diskMb);
      return { diskMb: request.diskMb };
    });
  }

  /** R31: the file only gets longer; the guest grows its file system itself at its next boot. */
  function grow(request: Sized): Promise<unknown> {
    return locks.withAgent(request.agentId, async () => {
      const file = state.diskPath(request.agentId, null);
      if (!fileExists(file)) throw new VmdFailure("not_found");
      if (await agentIsRunning(request.agentId)) throw new VmdFailure("conflict");
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
    return locks.withAgent(request.agentId, async () => {
      if (request.taskKey !== null) {
        if (await agentIsRunning(request.agentId, request.taskKey)) throw new VmdFailure("conflict");
        const disk = state.diskPath(request.agentId, request.taskKey);
        if (!folderExists(path.dirname(disk))) throw new VmdFailure("not_found");
        removeTaskDir(disk);
        return { deleted: true };
      }
      const folder = state.agentDir(request.agentId);
      if (!folderExists(folder)) throw new VmdFailure("not_found");
      // R30: never while any VM of the agent runs (the agent's disk may be attached).
      if (await agentIsRunning(request.agentId)) throw new VmdFailure("conflict");
      if (request.purge) rmSync(folder, { recursive: true, force: true });
      else renameSync(folder, path.join(state.root, "trash", `${request.agentId}-${clock.now()}`));
      return { deleted: true };
    });
  }

  /** R31: a staging copy of the user's tree becomes a new disk; the result is never mounted, the staging copy never kept. */
  function populate(request: AgentDisk): Promise<unknown> {
    return locks.joinPopulate(request.agentId, async () => {
      const file = state.diskPath(request.agentId, null);
      if (fileExists(file)) throw new VmdFailure("conflict");
      const copy = state.stagingDir(request.agentId);
      const source = path.join(deps.papHome, "vm", "staging", request.agentId);
      try {
        const refused = copyTreeSafely(source, copy, deps.papUid, {
          maxBytes: POPULATE_MAX_MB * MIB,
          maxEntries: POPULATE_MAX_ENTRIES,
        });
        if (refused === "missing") throw new VmdFailure("not_found");
        if (refused !== null) throw new VmdFailure("bad_request");
        const diskMb = Math.min(
          POPULATE_MAX_MB,
          Math.max(POPULATE_MIN_MB, Math.ceil(treeMiB(copy) * 1.25) + 256),
        );
        await room(diskMb);
        await makeBlankDisk(exec, file, diskMb, copy);
        return { diskMb };
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    });
  }

  return { create, grow, remove, populate };
}
