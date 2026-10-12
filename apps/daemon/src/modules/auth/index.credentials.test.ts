import type { HandlerContext } from "@pap/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

it("authenticateCredential with slide: false never writes a bearer's last use nor extends a cookie (M5R72)", async () => {
  const { auth, app } = bed.start(ORIGIN);
  const setup = await app.request("/auth/setup", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: setupTokenOf(auth), username: "owner", password: PASSWORD }),
  });
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0]?.replace("pap_session=", "") ?? "";
  const userId = auth.authenticateCookieHeader(`pap_session=${cookie}`)?.userId ?? "";
  const ctx: HandlerContext = {
    caller: testCaller({ userId, stepUpUntil: bed.clock.now() + 60_000 }),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  };
  const created = await auth.rpc["auth.tokens.create"](
    { name: "ci", permissions: ["sessions:read"], expiresInDays: 30 },
    ctx,
  );
  const bearer = { kind: "bearer", value: created.value } as const;
  const session = { kind: "cookie", value: cookie } as const;
  const lastUse = () => bed.db.get<{ at: number | null }>("SELECT last_used_at AS at FROM api_tokens")?.at;
  const expiry = () => bed.db.get<{ at: number }>("SELECT expires_at AS at FROM auth_sessions")?.at;
  const before = expiry();
  await bed.clock.advance(2 * 24 * 3600 * 1000);

  expect(auth.authenticateCredential(bearer, { slide: false })?.kind).toBe("token");
  expect(auth.authenticateCredential(session, { slide: false })?.kind).toBe("session");
  expect(lastUse()).toBeNull();
  expect(expiry()).toBe(before);

  expect(auth.authenticateCredential(bearer)?.kind).toBe("token");
  expect(auth.authenticateCredential(session)?.kind).toBe("session");
  expect(lastUse()).toBe(bed.clock.now());
  expect(expiry()).toBe(bed.clock.now() + 30 * 24 * 3600 * 1000);
});
