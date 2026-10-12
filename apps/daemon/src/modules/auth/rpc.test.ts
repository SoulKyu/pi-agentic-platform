import { afterEach, describe, expect, it } from "vitest";
import { methods, type HandlerContext } from "@pap/contracts";
import { authRpc } from "./rpc.ts";
import { createTokenBed } from "./testing/token-bed.ts";

let current: ReturnType<typeof createTokenBed> | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("auth.tokens.*", () => {
  it("creates, lists and revokes through the contract's own result shapes", async () => {
    current = createTokenBed();
    const bed = current;
    const rpc = authRpc(bed.tokens);
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
