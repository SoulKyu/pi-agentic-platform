import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTimeOf } from "../kernel/home.ts";
import { ALL_CHECKS } from "./doctor/registry.ts";
import { plain, renderJson, renderText } from "./doctor/render.ts";
import { runDoctor } from "./doctor/run.ts";
import type { Check, DoctorContext } from "./doctor/types.ts";
import type { CliIo } from "./open-home.ts";
import { resolveTarget, type Target } from "./ops/target.ts";
import type { Command } from "./run-cli.ts";
import { createSystemd } from "./service/systemd.ts";
import { UsageError } from "./usage.ts";
import { DEFAULT_OP_SEAMS } from "./update/operation.ts";

export const DOCTOR_USAGE =
  "usage: pap doctor [--json] [--only id[,id...]] [--unit <name>] [--home <abs dir>]";

const SOURCE = {
  flag: "the flag",
  unit: "the unit",
  environment: "the environment",
  default: "the default",
} as const;

/** What touches the machine; tests replace these. */
export interface DoctorSeams {
  /** Every check, in the order they run (`doctor/registry.ts`). */
  checks: readonly Check[];
  /** The effective unit text (`systemctl cat`, else the unit file), or null when no unit is installed. */
  unitText(io: CliIo, unit: string): Promise<string | null>;
  inContainer(): boolean;
  lockHeld(home: string): boolean;
}

/** Whether a live daemon holds `pap.lock`: read only, the lock is never taken (doctor creates nothing). */
export function lockHeldAt(home: string): boolean {
  try {
    const [pidText = "", started] = readFileSync(join(home, "pap.lock"), "utf8").trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    const now = startTimeOf(pid);
    return started === undefined || now === null || now === started;
  } catch {
    return false;
  }
}

const DEFAULT_SEAMS: DoctorSeams = {
  checks: ALL_CHECKS,
  unitText: DEFAULT_OP_SEAMS.unitText,
  inContainer: () => existsSync("/run/.containerenv") || existsSync("/.dockerenv"),
  lockHeld: lockHeldAt,
};

/**
 * The unit and the home (M6bR28): the unit from `--unit` / `PAP_UNIT` / `pap.service`; the home from `--home`, else the installed
 * unit's, else an explicit `PAP_HOME`, else `~/.pap`. This is not the order of backup and restore (shell first): a shell with
 * `PAP_HOME` unset or different must not make doctor look at a home the service does not use.
 */
async function resolve(io: CliIo, seams: DoctorSeams, unitFlag?: string, homeFlag?: string) {
  const { unit } = resolveTarget(unitFlag === undefined ? {} : { unit: unitFlag }, io.env, io.homedir, null);
  const text = await seams.unitText(io, unit);
  const args = homeFlag === undefined ? { unit } : { unit, home: homeFlag };
  let target: Target = resolveTarget(args, {}, io.homedir, text);
  const shell = io.env.PAP_HOME;
  if (target.homeSource === "default" && shell !== undefined && shell !== "")
    target = resolveTarget(args, { PAP_HOME: shell }, io.homedir, text);
  return { target, installed: text !== null };
}

export function makeDoctorCommand(overrides: Partial<DoctorSeams> = {}): Command {
  const seams: DoctorSeams = { ...DEFAULT_SEAMS, ...overrides };
  return {
    options: {
      json: { type: "boolean" },
      only: { type: "string" },
      unit: { type: "string" },
      home: { type: "string" },
      help: { type: "boolean" },
    },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${DOCTOR_USAGE}\n`);
        return 0;
      }
      if (positionals.length > 0) throw new UsageError("doctor takes no argument");
      const str = (name: string): string | undefined =>
        typeof values[name] === "string" ? values[name] : undefined;
      const only = str("only")
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      if (only?.length === 0) throw new UsageError("--only needs at least one check id");
      const { target, installed } = await resolve(io, seams, str("unit"), str("home"));
      const ctx: DoctorContext = {
        io,
        env: io.env,
        homedir: io.homedir,
        home: target.home,
        homeSource: target.homeSource,
        unitName: target.unit,
        unit: target.parsed,
        unitUnreadable: installed && target.parsed === null,
        lockHeld: seams.lockHeld(target.home),
        systemd: createSystemd(io.env, { unit: target.unit }),
        inContainer: seams.inContainer(),
        clock: io.clock,
      };
      const report = await runDoctor(seams.checks, ctx, only);
      if (values.json === true) {
        io.stdout.write(renderJson(report));
        return report.exit;
      }
      const state = !installed
        ? "not installed"
        : target.parsed === null
          ? "installed, but pap cannot read it"
          : "installed";
      io.stdout.write(
        `unit: ${plain(target.unit)} (${state})\nhome: ${plain(target.home)} (from ${SOURCE[target.homeSource]})\n`,
      );
      io.stdout.write(renderText(report));
      return report.exit;
    },
  };
}

export const doctor: Command = makeDoctorCommand();
