import { PUSH_LIMITS, type HandlerContext } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { testCaller } from "../../../testing/caller.ts";
import { createPresence } from "./presence.ts";
import { deliveryRpc } from "./rpc.ts";

const ID = "abcdefghijklmnopqrstuv";
const ctx = (connectionId: string, overrides = {}): HandlerContext => ({
  caller: testCaller(overrides),
  connectionId,
  openSubscription: () => "sub",
  closeSubscription: () => {},
});
const token = { kind: "token", credentialId: "tok-1" } as const;

describe("push.presence", () => {
  const rig = () => {
    const presence = createPresence(createFakeClock());
    const rpc = deliveryRpc({ presence });
    return { presence, rpc };
  };

  it("reports the caller's own connection, taken from the authenticated context", async () => {
    const { presence, rpc } = rig();
    await rpc["push.presence"]({ focused: true }, ctx("c1"));
    expect(presence.looking("u1")).toBe(true);
    await rpc["push.presence"]({ focused: false }, ctx("c1"));
    // One entry per connection: the second report overwrote the first.
    expect(presence.looking("u1")).toBe(false);
  });

  it("two connections of the owner: one focused is enough to be looking", async () => {
    const { presence, rpc } = rig();
    await rpc["push.presence"]({ focused: false }, ctx("c1"));
    await rpc["push.presence"]({ focused: true }, ctx("c2"));
    expect(presence.looking("u1")).toBe(true);
    await rpc["push.presence"]({ focused: false }, ctx("c2"));
    expect(presence.looking("u1")).toBe(false);
  });

  it("a connection id in the params is ignored", async () => {
    const { presence, rpc } = rig();
    const spy = vi.spyOn(presence, "report");
    await rpc["push.presence"]({ focused: true, connectionId: "forged" } as never, ctx("real"));
    expect(spy).toHaveBeenCalledWith("u1", "real", true);
  });

  it("a token is forbidden and learns nothing", async () => {
    const { presence, rpc } = rig();
    const spy = vi.spyOn(presence, "report");
    await expect(rpc["push.presence"]({ focused: true }, ctx("c1", token))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("the 65th connection is refused with capacity", async () => {
    const { rpc } = rig();
    for (let i = 0; i < PUSH_LIMITS.presenceEntries; i++)
      await rpc["push.presence"]({ focused: true }, ctx(`c${i}`));
    await expect(rpc["push.presence"]({ focused: true }, ctx("c-extra"))).rejects.toMatchObject({
      code: "capacity",
    });
    // A known connection still reports at the cap.
    await expect(rpc["push.presence"]({ focused: false }, ctx("c0"))).resolves.toBeDefined();
  });
});

describe("push.open", () => {
  it("decodes, calls the service with the caller and the id, and returns its answer", async () => {
    const open = vi.fn(async () => ({ target: { kind: "inbox" as const, id: null } }));
    const rpc = deliveryRpc({ open });
    const c = ctx("c1");
    expect(await rpc["push.open"]({ id: ID }, c)).toEqual({ target: { kind: "inbox", id: null } });
    expect(open).toHaveBeenCalledWith(c.caller, ID);
  });

  it("a token is forbidden before the service runs", async () => {
    const open = vi.fn();
    const rpc = deliveryRpc({ open });
    await expect(rpc["push.open"]({ id: ID }, ctx("c1", token))).rejects.toMatchObject({ code: "forbidden" });
    expect(open).not.toHaveBeenCalled();
  });
});
