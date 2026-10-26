import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { statfs as statfsOf } from "node:fs/promises";
import path from "node:path";
import { AgentId, LaunchId, TaskKey, type BoxRef, type VmdRequest } from "@pap/contracts";
import { boxFolder, boxOfTrashPrefix, sameBox, trashPrefix } from "./box-name.ts";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";

export type ImageLayer = Extract<VmdRequest, { op: "image.build" }>["layer"];
const LAYERS: readonly string[] = ["base", "profile", "agent"] satisfies readonly ImageLayer[];

/** RT-40: a trash entry lives 7 days. */
export const TRASH_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MIB = 1024 * 1024;

export interface RunningTask {
  readonly box: BoxRef;
  readonly taskKey: string;
}

export interface StateDeps {
  /** `/var/lib/pap-vm/<pap uid>` (0700, root). */
  readonly root: string;
  readonly clock: Clock;
  readonly log: Logger;
  /** The state folder's file system; defaults to `fs.promises.statfs`. */
  readonly statfs?: (where: string) => Promise<{ bavail: number; bsize: number }>;
  /** The uid that must own every folder (root in production); defaults to the process's own. */
  readonly ownerUid?: number;
}

/**
 * R3: the state folder is root's. Every path is derived here from ids that the contracts' schemas already checked and
 * that are checked again (an id never holds a slash or a dot, so no path can leave the root). The daemon's user cannot
 * write anywhere in it; folders are still `lstat`ed so a link (or a folder of someone else) is refused, never followed.
 */
export interface VmdState {
  readonly root: string;
  ensure(): void;
  /** `agents/<id>` or `projects/<uuid>`. */
  boxDir(box: BoxRef): string;
  /** Where `disk.delete` moves a box folder: `trash/<prefix>-<stamp>`, the prefix telling the two kinds apart. */
  trashPath(box: BoxRef, stamp: number): string;
  diskPath(box: BoxRef, taskKey: string | null): string;
  /** A trigger's kept task disk: `agents/<id>/kept/<keepKey>/disk.img`, beside `tasks/` (the sweep never reads it). */
  keptPath(box: BoxRef, keepKey: string): string;
  envFile(launchId: string): string;
  buildDir(layer: ImageLayer): string;
  /** The folder holding `Dockerfile`, outside every build context (RT-33). */
  dockerfileDir(layer: ImageLayer): string;
  writeEnvFile(launchId: string, text: string): string;
  removeEnvFile(launchId: string): void;
  freeMb(): Promise<number>;
  /** `running` null: the caller cannot say which VMs run, so no task disk is touched (fails closed). */
  sweepAtStart(running: readonly RunningTask[] | null): void;
  /** Removes trash entries older than 7 days (`box` null) or every entry of one box now. Returns the count. */
  purgeTrash(box: BoxRef | null): number;
  /** Purges now and then once a day; the returned function stops it. */
  startDailyPurge(): () => void;
}

const TRASH_NAME = /^(.+)-(\d{10,16})$/;

export function createState(deps: StateDeps): VmdState {
  const { root, clock, log } = deps;
  const statfs = deps.statfs ?? ((where: string) => statfsOf(where));
  const ownerUid = deps.ownerUid ?? process.getuid?.() ?? 0;
  const dir = (...parts: string[]): string => path.join(root, ...parts);
  const boxDir = (box: BoxRef): string => dir(...boxFolder(box));

  function ensureDir(where: string): void {
    mkdirSync(where, { recursive: true, mode: 0o700 });
    const stat = lstatSync(where);
    if (!stat.isDirectory()) throw new Error(`state: ${where} is a link or not a folder`);
    if (stat.uid !== ownerUid) throw new Error(`state: ${where} belongs to another user`);
    chmodSync(where, 0o700);
  }

  /** The names in a folder, or none when it is a link or not a folder (a listing never follows a link). */
  function names(where: string): string[] {
    try {
      if (!lstatSync(where).isDirectory()) return [];
      return readdirSync(where);
    } catch {
      return [];
    }
  }

  const envFile = (launchId: string): string => dir("run", `${LaunchId.parse(launchId)}.env`);

  function purgeTrash(box: BoxRef | null): number {
    let removed = 0;
    for (const name of names(dir("trash"))) {
      const match = TRASH_NAME.exec(name);
      const owner = boxOfTrashPrefix(match?.[1] ?? "");
      if (owner === null) continue;
      const age = clock.now() - Number(match?.[2]);
      const due = box === null ? age > TRASH_TTL_MS : sameBox(owner, box);
      if (!due) continue;
      rmSync(dir("trash", name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  return {
    root,
    boxDir,
    trashPath: (box, stamp) => dir("trash", `${trashPrefix(box)}-${stamp}`),
    ensure() {
      for (const sub of ["agents", "projects", "trash", "run", "build", "dockerfiles"]) ensureDir(dir(sub));
      ensureDir(root);
    },
    diskPath(box, taskKey) {
      if (taskKey === null) return path.join(boxDir(box), "disk.img");
      if (box.kind !== "agent") throw new Error("state: a project box has no task disk");
      return path.join(boxDir(box), "tasks", TaskKey.parse(taskKey), "disk.img");
    },
    keptPath(box, keepKey) {
      if (box.kind !== "agent") throw new Error("state: a project box has no kept disk");
      return path.join(boxDir(box), "kept", TaskKey.parse(keepKey), "disk.img");
    },
    envFile,
    buildDir(layer) {
      if (!LAYERS.includes(layer)) throw new Error("state: unknown layer");
      return dir("build", layer);
    },
    dockerfileDir(layer) {
      if (!LAYERS.includes(layer)) throw new Error("state: unknown layer");
      return dir("dockerfiles", layer);
    },
    writeEnvFile(launchId, text) {
      const file = envFile(launchId);
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return file;
    },
    removeEnvFile(launchId) {
      rmSync(envFile(launchId), { force: true });
    },
    async freeMb() {
      const { bavail, bsize } = await statfs(root);
      return Math.floor((bavail * bsize) / MIB);
    },
    sweepAtStart(running) {
      // A crash mid-build leaves build/<layer>/<tag> and dockerfiles/<layer>/<tag>; no build runs while vmd starts.
      let buildFolders = 0;
      for (const top of ["build", "dockerfiles"]) {
        for (const layer of LAYERS) {
          for (const tag of names(dir(top, layer))) {
            rmSync(dir(top, layer, tag), { recursive: true, force: true });
            buildFolders += 1;
          }
        }
      }
      if (buildFolders > 0) log.info("vmd_build_sweep", { folders: buildFolders });
      let envFiles = 0;
      for (const name of names(dir("run"))) {
        if (!name.endsWith(".env")) continue;
        rmSync(dir("run", name), { recursive: true, force: true });
        envFiles += 1;
      }
      if (running === null) {
        log.info("vmd_sweep_skipped", { reason: "running_vms_unknown", envFiles });
        return;
      }
      const alive = new Set(running.map((task) => `${task.box.id}/${task.taskKey}`));
      let taskDisks = 0;
      for (const id of names(dir("agents"))) {
        if (!AgentId.safeParse(id).success) continue;
        const tasks = dir("agents", id, "tasks");
        for (const key of names(tasks)) {
          if (!TaskKey.safeParse(key).success || alive.has(`${id}/${key}`)) continue;
          rmSync(path.join(tasks, key), { recursive: true, force: true });
          taskDisks += 1;
        }
      }
      log.info("vmd_sweep", { envFiles, taskDisks });
    },
    purgeTrash,
    startDailyPurge() {
      let timer: ReturnType<Clock["setTimeout"]> | null = null;
      const tick = (): void => {
        try {
          const removed = purgeTrash(null);
          if (removed > 0) log.info("vmd_trash_purged", { removed });
        } catch (error) {
          log.info("vmd_trash_purge_failed", { error: error instanceof Error ? error.name : "unknown" });
        }
        timer = clock.setTimeout(tick, DAY_MS);
      };
      tick();
      return () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
      };
    },
  };
}
