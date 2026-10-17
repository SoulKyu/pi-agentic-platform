import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createRequestsBed, papCode, type RequestsBed } from "./testing/requests-bed.ts";

let t: RequestsBed;
afterEach(() => t.bed.dispose());

const REF_HASH = "ab".repeat(32);

describe("the secret half of the requests (M11R103)", () => {
  it("secretOf reads a pending secret request of the owner: the agent, the session and the name", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(
      t.input({ kind: "secret", title: "GRAFANA_TOKEN", detail: "why", sessionId: "s9" }),
    );
    expect(t.requests.secretOf("u1", id)).toEqual({
      id,
      agentId: t.agentId,
      sessionId: "s9",
      name: "GRAFANA_TOKEN",
    });
    expect(t.requests.secretOf("u2", id)).toBeNull();
    expect(t.requests.secretOf("u1", "missing")).toBeNull();
  });

  it("secretOf is null for an approval and for a request that is closed", async () => {
    t = await createRequestsBed();
    const approval = t.requests.open(t.input());
    const secret = t.requests.open(t.input({ kind: "secret", title: "GRAFANA_TOKEN" }));
    expect(t.requests.secretOf("u1", approval)).toBeNull();
    t.requests.cancel(secret);
    expect(t.requests.secretOf("u1", secret)).toBeNull();
  });

  it("closeSecret closes once, with the ref's hash, and resolves the item and the waiter", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input({ kind: "secret", title: "GRAFANA_TOKEN" }));
    const waiting = t.requests.wait(id);
    expect(t.requests.closeSecret(id, "answered", REF_HASH)).toBe(true);
    expect(await waiting).toBe("answered");
    expect(t.bed.db.get("SELECT state, ref_hash FROM agent_requests WHERE id = $id", { id })).toEqual({
      state: "answered",
      ref_hash: REF_HASH,
    });
    expect(t.resolved.at(-1)).toEqual({
      ownerId: "u1",
      kind: "secret_request",
      refId: id,
      resolution: "answered",
    });
    expect(t.requests.closeSecret(id, "answered", REF_HASH)).toBe(false);
  });

  it("closeSecret declined keeps no hash", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input({ kind: "secret", title: "GRAFANA_TOKEN" }));
    expect(t.requests.closeSecret(id, "declined", null)).toBe(true);
    expect(t.bed.db.get("SELECT state, ref_hash FROM agent_requests WHERE id = $id", { id })).toEqual({
      state: "declined",
      ref_hash: null,
    });
  });

  it("closeSecret does nothing for an approval (its rows never hold a hash)", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    expect(t.requests.closeSecret(id, "answered", REF_HASH)).toBe(false);
    expect(t.stateOf(id)?.state).toBe("pending");
  });

  it("answer (the approval's) refuses anything but a browser session, in the fail-closed form", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const odd = testCaller({ kind: "device" as never });
    expect(await papCode(() => t.requests.answer(odd, id, true))).toBe("forbidden");
    expect(t.stateOf(id)?.state).toBe("pending");
  });
});
