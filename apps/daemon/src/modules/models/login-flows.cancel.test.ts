import { describe, expect, it } from "vitest";
import { createLoginFlows } from "./login-flows.ts";
import { bed, settle } from "./testing/flows-bed.ts";

describe("cancelling by provider (MC31)", () => {
  it("cancels the caller's own live flow for that provider and frees the slot for a new sign-in", async () => {
    const { flows, fakes, doneOf } = bed(createLoginFlows);
    const flowId = flows.start("u1", "a", "oauth");
    flows.attach("u1", flowId); // the subscriber is gone (a reload) but the flow still holds its provider
    expect(() => flows.start("u1", "a", "oauth")).toThrow(expect.objectContaining({ code: "conflict" }));
    flows.cancelByProvider("u1", "a");
    expect(fakes[0]?.cancelled).toBe(1);
    expect(doneOf(flowId)).toEqual([{ flowId, event: { kind: "done", ok: false } }]);
    expect(flows.start("u1", "a", "oauth")).toMatch(/^flow/);
    expect(fakes).toHaveLength(2);
  });

  it("answers not_found for another user's flow, for a provider with none and for an ended one, touching nothing", async () => {
    const { flows, fakes } = bed(createLoginFlows);
    flows.start("u1", "a", "oauth");
    const notFound = expect.objectContaining({ code: "not_found" });
    expect(() => flows.cancelByProvider("u2", "a")).toThrow(notFound);
    expect(() => flows.cancelByProvider("u1", "b")).toThrow(notFound);
    expect(fakes[0]?.cancelled).toBe(0);
    fakes[0]?.finish();
    await settle();
    expect(() => flows.cancelByProvider("u1", "a")).toThrow(notFound);
  });
});
