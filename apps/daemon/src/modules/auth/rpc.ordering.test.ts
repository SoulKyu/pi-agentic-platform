import { afterEach, expect, it } from "vitest";
import type { HandlerContext } from "@pap/contracts";
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

it("auth.tokens.revoke has deleted the row before its first await (M5R9)", async () => {
  current = createTokenBed();
  const bed = current;
  devicesBed = createDeviceBed();
  const { token } = bed.tokens.create(bed.confirmed(), {
    name: "ci",
    permissions: ["sessions:read"],
    expiresInDays: 7,
  });
  const ctx: HandlerContext = {
    caller: bed.confirmed(),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  };
  const pending = authRpc(bed.tokens, devicesBed.devices)["auth.tokens.revoke"]({ tokenId: token.id }, ctx);
  expect(bed.db.all("SELECT id FROM api_tokens")).toEqual([]); // not awaited yet
  await pending;
});
