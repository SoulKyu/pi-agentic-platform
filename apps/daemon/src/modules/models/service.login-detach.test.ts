import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { LOGIN_LIMITS } from "./login-flows.ts";
import { modelsBed } from "./testing/bed.ts";

// MC31, through the service: the hub's "last subscriber left" reaches the flow and restores the 60 s rule.
const pending = () => new Promise<never>(() => {});
const done = (published: Array<{ stream: string; key: string; event: unknown }>, flowId: string) =>
  published.filter(
    (line) =>
      line.stream === "login" && line.key === flowId && (line.event as { kind: string }).kind === "done",
  );

describe("a sign-in whose page went away (MC31)", () => {
  it("is cancelled 60 seconds after the last subscriber left, not before", async () => {
    const { service, published, clock, lastSubscriberLeft } = modelsBed(() => pending());
    const owner = testCaller({ stepUpUntil: clock.now() + 600_000 });
    const { flowId } = await service.login(owner, { provider: "anthropic", method: "oauth" });
    await service.subscribeLogin(owner, flowId, () => "sub1");
    await clock.advance(LOGIN_LIMITS.idleMs * 5);
    expect(done(published, flowId)).toEqual([]);
    lastSubscriberLeft(flowId);
    await clock.advance(LOGIN_LIMITS.idleMs - 1);
    expect(done(published, flowId)).toEqual([]);
    await clock.advance(1);
    expect(done(published, flowId)).toMatchObject([{ event: { kind: "done", ok: false, code: "timeout" } }]);
  });

  it("is left alone when the page comes back within the minute", async () => {
    const { service, published, clock, lastSubscriberLeft } = modelsBed(() => pending());
    const owner = testCaller({ stepUpUntil: clock.now() + 600_000 });
    const { flowId } = await service.login(owner, { provider: "anthropic", method: "oauth" });
    await service.subscribeLogin(owner, flowId, () => "sub1");
    lastSubscriberLeft(flowId);
    await clock.advance(LOGIN_LIMITS.idleMs - 1);
    await service.subscribeLogin(owner, flowId, () => "sub2");
    await clock.advance(LOGIN_LIMITS.idleMs * 5);
    expect(done(published, flowId)).toEqual([]);
  });
});
