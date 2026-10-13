import type { HandlerContext } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { authRpc } from "./rpc.ts";
import { createDeviceBed } from "./testing/device-bed.ts";
import { createPasskeyBed, CRED_A, CRED_B, CRED_OTHER, OWNER_ID, shortId } from "./testing/passkey-bed.ts";
import { createTokenBed } from "./testing/token-bed.ts";

let current: ReturnType<typeof createPasskeyBed> | undefined;
let others: Array<{ dispose(): void }> = [];
afterEach(() => {
  current?.dispose();
  for (const other of others) other.dispose();
  current = undefined;
  others = [];
});

it("auth.passkeys.remove has deleted the passkey and signed out its browsers before its first await (M5R9)", async () => {
  const bed = (current = createPasskeyBed());
  const tokenBed = createTokenBed();
  const deviceBed = createDeviceBed();
  others = [tokenBed, deviceBed];
  const byA = bed.startSession({ method: "passkey", passkeyRef: shortId(CRED_A) });
  bed.stepUps.mark(byA.idHash);
  const ctx: HandlerContext = {
    caller: bed.confirmed(),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  };
  const rpc = authRpc(tokenBed.tokens, deviceBed.devices, bed.manager);
  const pending = rpc["auth.passkeys.remove"]({ passkeyId: shortId(CRED_A) }, ctx);
  expect(bed.rows()).toEqual([CRED_B, CRED_OTHER]); // not awaited yet
  expect(bed.sessionsOf(OWNER_ID)).toEqual([]);
  expect(bed.stepUps.until(byA.idHash)).toBe(0);
  expect(await pending).toEqual({ revoked: 1 });
});

it("auth.passkeys.list answers the contract's shape", async () => {
  const bed = (current = createPasskeyBed());
  const tokenBed = createTokenBed();
  const deviceBed = createDeviceBed();
  others = [tokenBed, deviceBed];
  const ctx: HandlerContext = {
    caller: bed.owner,
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  };
  const rpc = authRpc(tokenBed.tokens, deviceBed.devices, bed.manager);
  expect((await rpc["auth.passkeys.list"]({}, ctx)).passkeys.map((p) => p.id)).toEqual([
    shortId(CRED_B),
    shortId(CRED_A),
  ]);
});
