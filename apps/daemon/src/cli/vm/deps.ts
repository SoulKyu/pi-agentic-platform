import type { Download, OpenFile, VmAssets } from "./assets.ts";
import { PATHS } from "./configs.ts";
import type { StatCode } from "./trusted-code.ts";

/** Where setup writes. Real runs use `PATHS`; tests inject temp folders, so no test touches /etc, /opt or /var/lib. */
export interface VmRoots {
  readonly opt: string;
  readonly kata: string;
  readonly etc: string;
  readonly state: string;
  readonly kataConfig: string;
  readonly units: string;
  readonly work: string;
  /** `/run/pap-vm`: containerd's runtime state, the IPAM reservations, the docker config (units stopped = nothing in use). */
  readonly run: string;
  /** `/var/lib/cni`: shared with other CNI users, so only the entries of pap's own network are removed. */
  readonly cniState: string;
}

export const REAL_ROOTS: VmRoots = Object.freeze({
  opt: PATHS.opt,
  kata: PATHS.kata,
  etc: PATHS.etc,
  state: PATHS.state,
  kataConfig: PATHS.kataConfig,
  units: PATHS.units,
  work: "/var/tmp",
  run: PATHS.run,
  cniState: "/var/lib/cni",
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
  /** The pins compiled into this pap. */
  readonly compiled: VmAssets;
  readonly openFile: OpenFile;
  /** Deploys pap-vmd with its production dependencies from the checkout into `dest` (the release step's code). */
  readonly deployVmd: (tree: string, dest: string) => Promise<void>;
  readonly download: Download;
  /** The text of /proc/self/mountinfo (uninstall refuses while a mount is left under pap's folders). */
  readonly readMounts: () => string;
  readonly nodePath: string;
  /** I3: what setup runs as root besides the pins: this program's entry and its folder, `vm-assets.json`, the running Node. */
  readonly codePaths: () => readonly string[];
  readonly statCode: StatCode;
  /** M11: the text of the user's `pap.service` (under `<user home>/.config/systemd/user`), or null when there is none. */
  readonly readUserUnit: (userHome: string) => string | null;
  /** The checkout this pap runs from, or undefined when it is not one. */
  readonly treeRoot: string | undefined;
}
