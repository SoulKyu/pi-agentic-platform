import type { Clock } from "../../kernel/clock.ts";
import type { CliIo } from "../open-home.ts";
import type { HomeSource } from "../ops/target.ts";
import type { Systemd } from "../service/systemd.ts";
import type { ParsedUnit } from "../service/unit-read.ts";

/** `info` is advisory and counts as ok; `skip` means the check does not apply here. */
export type CheckStatus = "ok" | "info" | "warn" | "fail" | "skip";

export interface CheckResult {
  readonly status: CheckStatus;
  /** One line. */
  readonly detail: string;
  /** A command or a doc anchor, never prose alone; absent when ok. */
  readonly fix?: string;
}

export interface DoctorContext {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
  readonly home: string;
  readonly homeSource: HomeSource;
  readonly unitName: string;
  /** The installed unit as pap reads it; null when no unit is installed or pap cannot read it. */
  readonly unit: ParsedUnit | null;
  /** True when a unit is installed but pap cannot parse it (a hand-written ExecStart): the listen flags are then unknown. */
  readonly unitUnreadable?: boolean;
  /** A live daemon holds `pap.lock` in `home` (read, never taken). */
  readonly lockHeld: boolean;
  readonly systemd: Systemd;
  readonly inContainer: boolean;
  readonly clock: Clock;
}

export interface Check {
  /** Stable: scripts and `--only` use it. */
  readonly id: string;
  readonly title: string;
  run(ctx: DoctorContext): Promise<CheckResult>;
}

export interface DoctorReport {
  readonly results: ReadonlyArray<{ readonly id: string; readonly title: string } & CheckResult>;
  /** 0 ok, info and skip only; 1 at least one fail; 2 warnings and no fail. */
  readonly exit: 0 | 1 | 2;
}
