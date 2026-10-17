import { readFileSync } from "node:fs";
import { CliError, type CliIo } from "../open-home.ts";
import { acquireOpLock, OpLockBusy } from "../ops/op-lock.ts";
import { readLockPid } from "../ops/paths.ts";
import { resolveTarget, type Target } from "../ops/target.ts";
import { unitFilePath } from "../service/common.ts";
import { createSystemd } from "../service/systemd.ts";
import { ancestorPids, runsInsideDaemon } from "./guard.ts";
import { makeApplyDeps } from "./wiring.ts";

export const INSIDE_SENTENCE = "run this from an SSH or console shell: stopping pap would end this terminal";

/** What touches the machine in an operation that stops the unit; tests replace these. */
export interface OpSeams {
  makeDeps: typeof makeApplyDeps;
  /** The effective unit text (`systemctl cat`, else the unit file), or null when no unit is installed. */
  unitText(io: CliIo, unit: string): Promise<string | null>;
  readCgroup(): string;
  ancestors(): number[];
}

async function readUnitText(io: CliIo, unit: string): Promise<string | null> {
  try {
    const text = await createSystemd(io.env, { unit }).cat(unit);
    if (text.trim() !== "") return text;
  } catch {
    // no user manager, or a unit name systemd refuses: the file is the other source
  }
  try {
    return readFileSync(unitFilePath(io, unit), "utf8").slice(0, 65_536);
  } catch {
    return null;
  }
}

export const DEFAULT_OP_SEAMS: OpSeams = {
  makeDeps: makeApplyDeps,
  unitText: readUnitText,
  readCgroup() {
    try {
      return readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return "";
    }
  },
  ancestors: () =>
    ancestorPids((pid) => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return null;
      }
    }),
};

/**
 * The start of `pap update apply|rollback|recover`: the unit decides the home, port, host and scheme (M6bR42, M6bR50); a shell
 * in pap's own terminal is refused before anything is written (M6bR52); `update/op.lock` is held for the whole `body` (M6bR51).
 */
export async function inOperation<T>(
  io: CliIo,
  seams: OpSeams,
  unitFlag: string | undefined,
  body: (target: Target) => Promise<T>,
): Promise<T> {
  const unit = resolveTarget(unitFlag === undefined ? {} : { unit: unitFlag }, io.env, io.homedir, null).unit;
  const text = await seams.unitText(io, unit);
  if (text === null)
    throw new CliError(
      `no installed unit ${unit}: run the installer with flags (docs/agents/install.md), then update`,
    );
  const target = resolveTarget({ unit }, {}, io.homedir, text);
  if (target.parsed === null)
    throw new CliError(
      `${unit} cannot be read by pap (a hand-edited unit?): reinstall it with the installer flags (docs/agents/install.md)`,
    );
  if (
    runsInsideDaemon({
      cgroupText: seams.readCgroup(),
      unit,
      ancestorPids: seams.ancestors(),
      daemonPid: readLockPid(target.home),
    })
  )
    throw new CliError(INSIDE_SENTENCE);
  let releaseOp: () => void;
  try {
    releaseOp = acquireOpLock(target.home);
  } catch (error) {
    if (error instanceof OpLockBusy) throw new CliError(error.message);
    throw error;
  }
  try {
    return await body(target);
  } finally {
    releaseOp();
  }
}
