import { describe, expect, it } from "vitest";
import { createLoginFlows, LOGIN_LIMITS } from "./login-flows.ts";
import { bed, settle } from "./testing/flows-bed.ts";

// MC31: the 60 s rule comes back when the last subscriber leaves (a reload, a closed tab).
describe("a flow whose last subscriber left (MC31)", () => {
  it("is cancelled after 60 seconds, like a flow nobody ever watched", async () => {
    const { flows, fakes, clock, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId);
    flows.detach(flowId);
    await clock.advance(LOGIN_LIMITS.idleMs - 1);
    expect(fakes[0]?.cancelled).toBe(0);
    await clock.advance(1);
    expect(fakes[0]?.cancelled).toBe(1);
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false, code: "timeout" } }]);
  });

  it("is left alone when a subscriber attaches again in time, and the timer is gone", async () => {
    const { flows, fakes, clock } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId);
    flows.detach(flowId);
    await clock.advance(LOGIN_LIMITS.idleMs - 1);
    flows.attach("u1", flowId);
    expect(clock.pending()).toBe(0);
    await clock.advance(LOGIN_LIMITS.idleMs * 5);
    expect(fakes[0]?.cancelled).toBe(0);
  });

  it("arms one timer however many times it is told", async () => {
    const { flows, clock } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId);
    flows.detach(flowId);
    flows.detach(flowId);
    expect(clock.pending()).toBe(1);
  });

  it("does nothing for a flow that ended, was forgotten, or never existed", async () => {
    const { flows, fakes, clock } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId);
    fakes[0]?.finish();
    await settle();
    flows.detach(flowId);
    flows.detach("no-such-flow");
    expect(clock.pending()).toBe(0);
  });
});
