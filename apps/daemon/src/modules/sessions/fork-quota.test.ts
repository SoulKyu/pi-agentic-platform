import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createAdmission, createForkQuota, FORK_CAP, FORK_WINDOW_MS } from "./fork-quota.ts";

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
};

describe("fork quota", () => {
  it("passes 30 and refuses the 31st with rate_limited", () => {
    const quota = createForkQuota(createFakeClock());
    for (let i = 0; i < FORK_CAP; i++) quota.admit("u1");
    expect(codeOf(() => quota.admit("u1"))).toBe("rate_limited");
    expect(codeOf(() => quota.admit("u1"))).toBe("rate_limited");
  });

  it("passes one more 10 minutes after the first, and not a moment before", async () => {
    const clock = createFakeClock();
    const quota = createForkQuota(clock);
    quota.admit("u1");
    await clock.advance(1000);
    for (let i = 1; i < FORK_CAP; i++) quota.admit("u1");
    await clock.advance(FORK_WINDOW_MS - 1001);
    expect(codeOf(() => quota.admit("u1"))).toBe("rate_limited");
    await clock.advance(1);
    quota.admit("u1");
    expect(codeOf(() => quota.admit("u1"))).toBe("rate_limited");
  });

  it("counts owners apart", () => {
    const quota = createForkQuota(createFakeClock());
    for (let i = 0; i < FORK_CAP; i++) quota.admit("u1");
    quota.admit("u2");
    expect(codeOf(() => quota.admit("u1"))).toBe("rate_limited");
  });

  it("forgets owners whose forks have all aged out", async () => {
    const clock = createFakeClock();
    const quota = createForkQuota(clock);
    for (let i = 0; i < 400; i++) quota.admit(`u${i}`);
    await clock.advance(FORK_WINDOW_MS + 1);
    quota.admit("late");
    expect(quota.owners()).toBeLessThan(10);
  });
});

describe("admission", () => {
  const MB = 1_048_576;
  const make = (freeMb: number) =>
    createAdmission({
      clock: createFakeClock(),
      logger: silentLogger,
      sessionsDir: "/x",
      minFreeDiskMb: 1024,
      statfs: () => ({ bavail: freeMb, bsize: MB }),
    });

  it("refuses a fork below the disk floor without counting it against the cap", () => {
    const admission = make(10);
    for (let i = 0; i < FORK_CAP + 5; i++) expect(codeOf(() => admission.fork("u1"))).toBe("disk_low");
  });

  it("refuses a task session below the floor", () => {
    expect(codeOf(() => make(10).task())).toBe("disk_low");
    expect(codeOf(() => make(5000).task())).toBeNull();
  });

  it("applies the cap above the floor", () => {
    const admission = make(5000);
    for (let i = 0; i < FORK_CAP; i++) admission.fork("u1");
    expect(codeOf(() => admission.fork("u1"))).toBe("rate_limited");
  });
});
