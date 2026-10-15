import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { createDiskGuard, type Statfs } from "../../kernel/disk.ts";
import type { Logger } from "../../kernel/logger.ts";

/** M10R100: at most 30 forks and clones per owner in any 10 minutes. */
export const FORK_CAP = 30;
export const FORK_WINDOW_MS = 600_000;
/** The disk floor when the config does not say (`PAP_MIN_FREE_DISK_MB` default). */
export const DEFAULT_MIN_FREE_DISK_MB = 1024;
/** Above this many owners with a list, every call drops the owners whose forks have all aged out. */
const SWEEP_ABOVE = 64;

export interface ForkQuota {
  /** Counts one fork or clone of the owner, or throws `rate_limited`. Check and count are one synchronous step. */
  admit(ownerId: string): void;
  /** Owners with a list now: bounded by the owners, tests read it. */
  owners(): number;
}

/** A sliding window on the Clock, one list of times per owner. */
export function createForkQuota(clock: Clock): ForkQuota {
  const byOwner = new Map<string, number[]>();
  const fresh = (times: number[], now: number): number[] => times.filter((at) => at > now - FORK_WINDOW_MS);
  return {
    admit(ownerId) {
      const now = clock.now();
      if (byOwner.size > SWEEP_ABOVE) {
        for (const [owner, times] of byOwner) {
          const kept = fresh(times, now);
          if (kept.length === 0) byOwner.delete(owner);
          else byOwner.set(owner, kept);
        }
      }
      const times = fresh(byOwner.get(ownerId) ?? [], now);
      if (times.length >= FORK_CAP) {
        byOwner.set(ownerId, times);
        throw new PapError("rate_limited");
      }
      times.push(now);
      byOwner.set(ownerId, times);
    },
    owners: () => byOwner.size,
  };
}

/** What a new session needs before anything is written (M10R100, M10R101). */
export interface Admission {
  /** `fork` and `clone`: the disk floor, then the owner's cap (a refusal by the disk is not counted). */
  fork(ownerId: string): void;
  /** `createTaskSession`: the disk floor. */
  task(): void;
}

export function createAdmission(options: {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Pi's sessions folder: the filesystem the new files go to. */
  readonly sessionsDir: string;
  readonly minFreeDiskMb: number;
  readonly statfs?: Statfs;
}): Admission {
  const quota = createForkQuota(options.clock);
  const disk = createDiskGuard({
    path: options.sessionsDir,
    floorMb: options.minFreeDiskMb,
    logger: options.logger,
    ...(options.statfs ? { statfs: options.statfs } : {}),
  });
  return {
    fork(ownerId) {
      disk();
      quota.admit(ownerId);
    },
    task: disk,
  };
}
