import { resolve } from "node:path";
import { homeFrom } from "../../kernel/config.ts";
import { CliError } from "../open-home.ts";
import type { ParsedUnit } from "../service/unit-read.ts";
import { parseUnit } from "../service/unit-read.ts";

export const UNIT_NAME = /^[a-z0-9@._-]{1,64}\.service$/;
const DEFAULT_UNIT = "pap.service";

export type HomeSource = "flag" | "environment" | "unit" | "default";

export interface Target {
  readonly unit: string;
  readonly home: string;
  readonly homeSource: HomeSource;
  /** The `PAP_HOME` of the installed unit, whatever won; null with no unit or a unit without one. */
  readonly unitHome: string | null;
  readonly parsed: ParsedUnit | null;
}

function absoluteHome(value: string, homedir: string, usage: boolean): string {
  try {
    return homeFrom({ PAP_HOME: value }, homedir);
  } catch (error) {
    throw new CliError(
      (error as Error).message.replace("PAP_HOME", usage ? "--home" : "PAP_HOME"),
      usage ? 64 : 1,
    );
  }
}

/**
 * Which unit and which home a command works on (M6bR50). Unit: `--unit`, then `PAP_UNIT`, then `pap.service`. Home: `--home`,
 * then an explicit `PAP_HOME`, then the installed unit's `PAP_HOME`, then `~/.pap`. `unitText` is the effective unit text
 * (`Systemd.cat` or the unit file) or null when no unit is installed.
 */
export function resolveTarget(
  args: { unit?: string; home?: string },
  env: NodeJS.ProcessEnv,
  homedir: string,
  unitText: string | null,
): Target {
  const wanted =
    args.unit ?? (env.PAP_UNIT === undefined || env.PAP_UNIT === "" ? DEFAULT_UNIT : env.PAP_UNIT);
  if (!UNIT_NAME.test(wanted))
    throw new CliError("the unit name must look like pap.service (a-z, 0-9, @ . _ -)", 64);
  const parsed = unitText === null ? null : parseUnit(unitText);
  const unitHome = parsed?.home ?? null;
  if (args.home !== undefined)
    return {
      unit: wanted,
      home: absoluteHome(args.home, homedir, true),
      homeSource: "flag",
      unitHome,
      parsed,
    };
  if (env.PAP_HOME !== undefined && env.PAP_HOME !== "")
    return {
      unit: wanted,
      home: absoluteHome(env.PAP_HOME, homedir, false),
      homeSource: "environment",
      unitHome,
      parsed,
    };
  if (unitHome !== null) return { unit: wanted, home: unitHome, homeSource: "unit", unitHome, parsed };
  return { unit: wanted, home: homeFrom({}, homedir), homeSource: "default", unitHome, parsed };
}

/**
 * The refusal for backup and restore when the installed unit runs on another home than the one resolved and `--home` was
 * not given: a shell without `PAP_HOME` must not touch `~/.pap` while the service works elsewhere.
 */
export function mismatch(target: Target): string | null {
  if (target.homeSource === "flag" || target.unitHome === null) return null;
  if (resolve(target.unitHome) === resolve(target.home)) return null;
  return `${target.unit} runs on ${target.unitHome}, not on ${target.home} (from ${target.homeSource === "environment" ? "the environment" : "the default"}): pass --home ${target.unitHome} to use the service's data, or --home ${target.home} to use this one`;
}
