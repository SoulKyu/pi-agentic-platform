import { afterEach, describe, expect, it } from "vitest";
import { methods, type HandlerContext } from "@pap/contracts";
import { authRpc } from "./rpc.ts";
import { createDeviceBed } from "./testing/device-bed.ts";
import { createTokenBed } from "./testing/token-bed.ts";

let current: ReturnType<typeof createTokenBed> | undefined;
let devicesBed: ReturnType<typeof createDeviceBed> | undefined;
afterEach(() => {
  current?.dispose();
  devicesBed?.dispose();
  current = devicesBed = undefined;
});

describe("auth.tokens.*", () => {
  it("creates, lists and revokes through the contract's own result shapes", async () => {
    current = createTokenBed();
    const bed = current;
    devicesBed = createDeviceBed();
    const rpc = authRpc(bed.tokens, devicesBed.devices);
    const ctx: HandlerContext = {
      caller: bed.confirmed(),
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => {},
    };
    const created = await rpc["auth.tokens.create"](
      { name: "ci", permissions: ["sessions:read"], expiresInDays: 30 },
      ctx,
    );
    expect(methods["auth.tokens.create"].result.parse(created)).toEqual(created);
    const listed = await rpc["auth.tokens.list"]({}, ctx);
    expect(methods["auth.tokens.list"].result.parse(listed)).toEqual({ tokens: [created.token] });
    expect(JSON.stringify(listed)).not.toContain(created.value);
    expect(await rpc["auth.tokens.revoke"]({ tokenId: created.token.id }, ctx)).toEqual({ ok: true });
    expect((await rpc["auth.tokens.list"]({}, ctx)).tokens).toEqual([]);
  });
});

describe("auth.devices.*", () => {
  it("lists, revokes and signs out the others through the contract's own result shapes", async () => {
    current = createTokenBed();
    const bed = (devicesBed = createDeviceBed());
    const rpc = authRpc(current.tokens, bed.devices);
    const ctx: HandlerContext = {
      caller: bed.current,
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => {},
    };
    const listed = await rpc["auth.devices.list"]({}, ctx);
    expect(methods["auth.devices.list"].result.parse(listed)).toEqual(listed);
    expect(listed.devices).toHaveLength(3);
    expect(await rpc["auth.devices.revoke"]({ deviceId: bed.publicIds.second }, ctx)).toEqual({ ok: true });
    const others = await rpc["auth.devices.revokeOthers"]({}, ctx);
    expect(methods["auth.devices.revokeOthers"].result.parse(others)).toEqual({ revoked: 1 });
    expect((await rpc["auth.devices.list"]({}, ctx)).devices.map((d) => d.current)).toEqual([true]);
  });
});
