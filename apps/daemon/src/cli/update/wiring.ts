import { freeMb } from "../../kernel/disk.ts";
import { acquireInstanceLock } from "../../kernel/home.ts";
import type { CliIo } from "../open-home.ts";
import { knownMigrationIds } from "../ops/schema-status.ts";
import type { Target } from "../ops/target.ts";
import { waitWithLoopHeld } from "../service/common.ts";
import { waitForListening, type Readiness } from "../service/readiness.ts";
import { createSystemd, type Systemd } from "../service/systemd.ts";
import type { ApplyDeps } from "./apply.ts";
import { probeHealth, type HealthTarget } from "./probe-health.ts";

const DEFAULT_PORT = 7777;
/** 20 reads of 500 ms: after each chunk without a `listening` line the unit state is asked (M6bR11e). */
const CHUNK_READS = 20;

export interface WiringOptions {
  readonly app: string;
  readonly deadlineMs: number;
  readonly settleMs: number;
  /** Tests only. */
  readonly systemd?: Systemd;
  readonly probe?: (target: HealthTarget) => Promise<boolean>;
}

/** Builds the real `ApplyDeps` for the unit `target` names; the unit's own flags decide the port, host and scheme (M6bR42). */
export async function makeApplyDeps(io: CliIo, target: Target, options: WiringOptions): Promise<ApplyDeps> {
  const parsed = target.parsed;
  if (parsed === null) throw new Error("the unit text is not readable");
  const systemd = options.systemd ?? createSystemd(io.env, { unit: target.unit });
  const port = parsed.port ?? DEFAULT_PORT;
  const healthTarget: HealthTarget = { host: parsed.host, port, tls: parsed.tls };
  const probe = options.probe ?? probeHealth;
  const sleep = (ms: number): Promise<void> => waitWithLoopHeld(() => io.clock.sleep(ms));
  const now = (): Date => new Date(io.clock.now());

  async function listening(since: Date, deadlineMs: number): Promise<Readiness> {
    const startedAt = io.clock.now();
    for (;;) {
      const answer = await waitForListening({ systemd, sleep, now }, target.unit, since, port, CHUNK_READS);
      if (answer.kind === "url" || answer.kind === "owner") return answer;
      // a release that hit the start limit does not make the owner wait the whole deadline
      if ((await systemd.activeState(target.unit)) === "failed") return { kind: "never" };
      if (io.clock.now() - startedAt >= deadlineMs) return answer;
    }
  }

  return {
    app: options.app,
    home: target.home,
    knownIds: knownMigrationIds(),
    systemd,
    listening,
    healthz: () => probe(healthTarget),
    sleep,
    now,
    freeMb: (path) => freeMb(path),
    holdHome() {
      const lock = acquireInstanceLock(target.home);
      return () => lock.release();
    },
    deadlineMs: options.deadlineMs,
    settleMs: options.settleMs,
    unit: target.unit,
  };
}
