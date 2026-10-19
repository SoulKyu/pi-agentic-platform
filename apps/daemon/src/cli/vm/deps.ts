import type { Download, VmAssets } from "./assets.ts";
import { PATHS } from "./configs.ts";

/** Where setup writes. Real runs use `PATHS`; tests inject temp folders, so no test touches /etc, /opt or /var/lib. */
export interface VmRoots {
  readonly opt: string;
  readonly kata: string;
  readonly etc: string;
  readonly state: string;
  readonly kataConfig: string;
  readonly units: string;
  readonly work: string;
}

export const REAL_ROOTS: VmRoots = Object.freeze({
  opt: PATHS.opt,
  kata: PATHS.kata,
  etc: PATHS.etc,
  state: PATHS.state,
  kataConfig: PATHS.kataConfig,
  units: PATHS.units,
  work: "/var/tmp",
});

export type Exec = (cmd: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>;

export interface VmUser {
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

export interface VmDeps {
  readonly roots: VmRoots;
  readonly exec: Exec;
  readonly isRoot: boolean;
  /** Copies a file or folder (links stay links). Only `--dev-from-tree` may call it. */
  readonly copyTree: (source: string, destination: string) => void;
  readonly lookupUser: (name: string) => VmUser | undefined;
  readonly loadAssets: (file: string | undefined) => VmAssets;
  readonly download: Download;
  readonly nodePath: string;
  /** The checkout this pap runs from, or undefined when it is not one. */
  readonly treeRoot: string | undefined;
}
