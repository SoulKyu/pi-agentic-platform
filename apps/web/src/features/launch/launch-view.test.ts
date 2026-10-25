import { LAUNCH_STEP_LIMITS_MS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { launchAt, stepOf } from "../../testing/launch-bed.ts";
import { askOf, isSlow } from "./launch-view.ts";

const T0 = 1_000_000;

describe("launch view derivations", () => {
  it("slower than usual appears past twice the median, in neutral text", () => {
    const step = stepOf("vm", { state: "running", startedAt: T0, usualMs: 10_000 });
    expect(isSlow(step, T0 + 20_000)).toBe(false);
    expect(isSlow(step, T0 + 20_001)).toBe(true);
    // no median yet (fewer than 3 samples): never slow
    expect(isSlow({ ...step, usualMs: null }, T0 + 500_000)).toBe(false);
    // a step that is over is not slow any more
    expect(isSlow({ ...step, state: "done", endedAt: T0 + 30_000 }, T0 + 40_000)).toBe(false);
  });

  it("the ask appears at 75 % of the guest limit (R14: the long ask, by elapsed time)", () => {
    const limit = LAUNCH_STEP_LIMITS_MS.guest;
    const launch = launchAt("guest", T0);
    expect(askOf(launch, T0 + limit * 0.75 - 1)).toBeNull();
    const ask = askOf(launch, T0 + limit * 0.75);
    expect(ask).toMatchObject({ step: "guest", kind: "long", ms: 45_000, limitMs: limit, log: false });
  });

  it("an image step asks when its last line is older than 120 s", () => {
    const launch = launchAt("image", T0, {}, { detail: { line: "#7 RUN apt-get", at: T0 + 10_000 } });
    expect(askOf(launch, T0 + 130_000)).toBeNull();
    const ask = askOf(launch, T0 + 130_001);
    expect(ask).toMatchObject({ step: "image", kind: "quiet", ms: 120_001, log: true });
    // a build that printed nothing counts from its start
    const silent = launchAt("image", T0);
    expect(askOf(silent, T0 + 119_000)).toBeNull();
    expect(askOf(silent, T0 + 121_000)).toMatchObject({ kind: "quiet", ms: 121_000, log: true });
  });

  it("no ask while the launch waits behind another build", () => {
    const waiting = { reason: "image_build", position: 1 } as const;
    const queued = launchAt("image", T0, { waiting });
    expect(askOf(queued, T0 + 300_000)).toBeNull();
    // 75 % of the limit counts the wait too: still no ask
    expect(askOf(queued, T0 + LAUNCH_STEP_LIMITS_MS.image)).toBeNull();
    // the wait is over and the build prints nothing: the quiet time counts from the step start
    expect(askOf(launchAt("image", T0), T0 + 300_000)).toMatchObject({ kind: "quiet" });
  });

  it("the 75 % image ask is the long one, even with lines still flowing", () => {
    const limit = LAUNCH_STEP_LIMITS_MS.image;
    const at = T0 + limit * 0.75;
    const launch = launchAt("image", T0, {}, { detail: { line: "#9 RUN make", at: at - 3_000 } });
    expect(askOf(launch, at)).toMatchObject({ kind: "long", ms: limit * 0.75, log: true });
  });

  it("Stop is offered iff the daemon says the launch is stoppable (R13)", () => {
    const ask = (stoppable: boolean | undefined) =>
      askOf(launchAt("vm", T0 - 1_000_000, stoppable === undefined ? {} : { stoppable }), T0)?.stop;
    expect(ask(true)).toBe(true);
    expect(ask(false)).toBe(false);
    expect(ask(undefined)).toBe(false);
    const image = launchAt("image", T0 - 1_000_000, { stoppable: true });
    expect(askOf(image, T0)?.stop).toBe(true);
  });
});
