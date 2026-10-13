import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyV2Rpc } from "./rpc.ts";
import { createSessionPolicyService } from "./session-service.ts";
import { createSessionPolicyStore } from "./session-store.ts";
import { createSettingsPolicyStore } from "./settings-store.ts";
import { sessionPolicyBed as bedOf, type SessionPolicyBedParts } from "./testing/bed.ts";

const make = ({ db, clock, logger, audit, sessionOwner }: SessionPolicyBedParts) => {
  const service = createSessionPolicyService({
    sessions: createSessionPolicyStore(db),
    settings: createSettingsPolicyStore(db),
    clock,
    logger,
    audit,
    sessionOwner,
  });
  return { service, rpc: policyV2Rpc(service) };
};
const sessionPolicyBed = () => bedOf(make);

let current: ReturnType<typeof sessionPolicyBed>;
beforeEach(() => {
  current = sessionPolicyBed();
});
afterEach(() => current.dispose());
const bed = () => current;

describe("policy v2 rpc", () => {
  it("reads and saves the caller's settings with compare-and-set", async () => {
    const { rpc, ctxOf } = bed();
    expect(await rpc["policy.getSettings"]({}, ctxOf("u1"))).toEqual({ value: null, revision: 0 });
    expect(
      await rpc["policy.setSettings"](
        { value: { defaultMode: "read-only" } as never, baseRevision: 0 },
        ctxOf("u1"),
      ),
    ).toEqual({ revision: 1 });
    await expect(
      rpc["policy.setSettings"]({ value: {} as never, baseRevision: 0 }, ctxOf("u1")),
    ).rejects.toMatchObject({ code: "conflict" });
    const got = await rpc["policy.getSettings"]({}, ctxOf("u1"));
    expect(got).toMatchObject({ value: { defaultMode: "read-only" }, revision: 1 });
    expect(await rpc["policy.getSettings"]({}, ctxOf("u2"))).toEqual({ value: null, revision: 0 });
  });

  it("sets and clears a session's mode and taint for the caller only", async () => {
    const { rpc, ctxOf, service } = bed();
    expect(await rpc["policy.setSessionMode"]({ sessionId: "s1", mode: "supervised" }, ctxOf("u1"))).toEqual({
      ok: true,
    });
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "supervised", explicit: true });
    service.markTainted("u1", "s1");
    expect(await rpc["policy.clearTaint"]({ sessionId: "s1" }, ctxOf("u1"))).toEqual({ ok: true });
    expect(service.sessionPolicy("u1", "s1").taint).toEqual({ tainted: false, epoch: 1 });
    await expect(rpc["policy.setSessionMode"]({ sessionId: "s1", mode: null }, ctxOf("u2"))).rejects.toEqual(
      new PapError("not_found"),
    );
    await expect(rpc["policy.clearTaint"]({ sessionId: "nope" }, ctxOf("u1"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lets a handler decode refuse a bad setting as bad_request", async () => {
    const { rpc, ctxOf } = bed();
    await expect(
      rpc["policy.setSettings"](
        { value: { allowHosts: ["127.0.0.1"] } as never, baseRevision: 0 },
        ctxOf("u1"),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
