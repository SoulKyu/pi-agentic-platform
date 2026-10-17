import { EGRESS_UNKNOWN, type EgressStatus, type PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { CheckedProbe } from "../../kernel/sandbox/probe.ts";
import { createSandboxMethods, RECHECK_EVERY_MS } from "./sandbox.ts";

const PROXIED: EgressStatus = { usable: true, python: "/usr/bin/python3", reason: null };

function build(
  first: CheckedProbe,
  next: CheckedProbe = first,
  egress?: Parameters<typeof createSandboxMethods>[2],
) {
  const clock = createFakeClock(1_000_000);
  let current = first;
  let probes = 0;
  const methods = createSandboxMethods(
    {
      current: () => current,
      recheck: async () => {
        probes += 1;
        current = next;
        return next;
      },
    },
    clock,
    egress,
  );
  return { methods, clock, probes: () => probes };
}

describe("agents.sandboxStatus and agents.recheckSandbox (M11R19, M11R20)", () => {
  it("shows the real path when usable and the reason when not; checkedAt 0 before the first probe", () => {
    expect(build({ usable: true, path: "/usr/bin/bwrap", checkedAt: 5 }).methods.status()).toEqual({
      usable: true,
      path: "/usr/bin/bwrap",
      reason: null,
      checkedAt: 5,
      egress: EGRESS_UNKNOWN,
    });
    expect(build({ usable: false, reason: "missing", checkedAt: 0 }).methods.status()).toEqual({
      usable: false,
      path: null,
      reason: "missing",
      checkedAt: 0,
      egress: EGRESS_UNKNOWN,
    });
  });

  it("carries the egress proxy's status (M11R242): usable, or why not; unknown while no proxy is bound", () => {
    const usable = { usable: true, path: "/usr/bin/bwrap", checkedAt: 5 } as const;
    const bound = (status: EgressStatus) => ({ status: () => status, recheck: async () => {} });
    expect(build(usable, usable, bound(PROXIED)).methods.status().egress).toEqual(PROXIED);
    const down: EgressStatus = { usable: false, python: null, reason: "socket_path" };
    expect(build(usable, usable, bound(down)).methods.status().egress).toEqual(down);
    expect(build(usable).methods.status().egress).toEqual(EGRESS_UNKNOWN);
  });

  it("a re-check probes the interpreter again, once per accepted re-check, before it answers", async () => {
    let status: EgressStatus = { usable: false, python: null, reason: "no_python" };
    const recheck = vi.fn(async () => void (status = PROXIED));
    const { methods, clock } = build(
      { usable: true, path: "/usr/bin/bwrap", checkedAt: 1 },
      { usable: true, path: "/usr/bin/bwrap", checkedAt: 2 },
      { status: () => status, recheck },
    );
    expect((await methods.recheck()).egress).toEqual(PROXIED);
    await methods.recheck().catch(() => {});
    expect(recheck).toHaveBeenCalledTimes(1);
    await clock.advance(RECHECK_EVERY_MS);
    await methods.recheck();
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it("a re-check probes and answers the new status; a second one within 10 s is rate_limited and probes nothing", async () => {
    const { methods, clock, probes } = build(
      { usable: false, reason: "missing", checkedAt: 1 },
      { usable: true, path: "/usr/bin/bwrap", checkedAt: 2 },
    );
    expect(await methods.recheck()).toMatchObject({ usable: true, checkedAt: 2 });
    const refused = await methods.recheck().then(
      () => null,
      (error: PapError) => error.code,
    );
    expect(refused).toBe("rate_limited");
    expect(probes()).toBe(1);
    await clock.advance(RECHECK_EVERY_MS);
    await methods.recheck();
    expect(probes()).toBe(2);
  });
});
