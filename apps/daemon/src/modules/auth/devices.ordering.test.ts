import type { HandlerContext } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { authRpc } from "./rpc.ts";
import { createDeviceBed, OWNER_ID } from "./testing/device-bed.ts";
import { createTokenBed } from "./testing/token-bed.ts";

let current: ReturnType<typeof createDeviceBed> | undefined;
let tokenBed: ReturnType<typeof createTokenBed> | undefined;
afterEach(() => {
  current?.dispose();
  tokenBed?.dispose();
  current = tokenBed = undefined;
});

const rpcOf = (bed: ReturnType<typeof createDeviceBed>) => {
  tokenBed = createTokenBed();
  return authRpc(tokenBed.tokens, bed.devices);
};
const ctxOf = (bed: ReturnType<typeof createDeviceBed>): HandlerContext => ({
  caller: bed.current,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});

it("auth.devices.revoke has deleted the row before its first await (M5R9)", async () => {
  const bed = (current = createDeviceBed());
  const pending = rpcOf(bed)["auth.devices.revoke"]({ deviceId: bed.publicIds.second }, ctxOf(bed));
  expect(bed.sessionsOf(OWNER_ID)).toHaveLength(2); // not awaited yet
  await pending;
});

it("auth.devices.revokeOthers has deleted the rows before its first await (M5R9)", async () => {
  const bed = (current = createDeviceBed());
  const pending = rpcOf(bed)["auth.devices.revokeOthers"]({}, ctxOf(bed));
  expect(bed.sessionsOf(OWNER_ID)).toEqual([bed.publicIds.current]);
  expect(await pending).toEqual({ revoked: 2 });
});
