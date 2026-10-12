import { afterEach, expect, it } from "vitest";
import type { HandlerContext } from "@pap/contracts";
import { authRpc } from "./rpc.ts";
import { createTokenBed } from "./testing/token-bed.ts";

let current: ReturnType<typeof createTokenBed> | undefined;
afterEach(() => current?.dispose());

it("auth.tokens.revoke has deleted the row before its first await (M5R9)", async () => {
  current = createTokenBed();
  const bed = current;
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
  const pending = authRpc(bed.tokens)["auth.tokens.revoke"]({ tokenId: token.id }, ctx);
  expect(bed.db.all("SELECT id FROM api_tokens")).toEqual([]); // not awaited yet
  await pending;
});
