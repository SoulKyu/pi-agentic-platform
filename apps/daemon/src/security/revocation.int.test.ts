import { describe, expect, it } from "vitest";
import {
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "../modules/auth/testing/software-authenticator.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";
import { rowsOf } from "./testing/fixtures.ts";

// Spec C §8.1 over /ws: removing a passkey signs out the browsers it opened (M5R9), and their sockets close with 4401.
const PASSWORD = "correct horse battery staple";

/** The real ceremonies over the daemon's routes, with a software authenticator for the rpId `localhost`. */
async function post(t: TestDaemon, path: string, body: object, cookie?: string) {
  const reply = await httpRequest(`${t.base}${path}`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: reply.status,
    body: JSON.parse(reply.body || "null") as never,
    cookie: reply.headers["set-cookie"]?.toString().split(";")[0] ?? "",
  };
}

async function enroll(t: TestDaemon, authenticator: SoftwareAuthenticator, cookie: string): Promise<void> {
  const begun = await post(t, "/auth/passkey/register/options", { password: PASSWORD }, cookie);
  expect(begun.status).toBe(200);
  const { flowId, options } = begun.body as {
    flowId: string;
    options: { challenge: string; user: { id: string } };
  };
  const done = await post(
    t,
    "/auth/passkey/register/verify",
    { flowId, response: authenticator.create(options) },
    cookie,
  );
  expect(done.status).toBe(200);
}

async function signInWithPasskey(t: TestDaemon, authenticator: SoftwareAuthenticator): Promise<string> {
  const begun = await post(t, "/auth/passkey/login/options", {});
  expect(begun.status).toBe(200);
  const { flowId, options } = begun.body as { flowId: string; options: { challenge: string } };
  const done = await post(t, "/auth/passkey/login/verify", { flowId, response: authenticator.get(options) });
  expect(done.status).toBe(200);
  return done.cookie;
}

describe("security: a removed passkey signs its browsers out (daemon)", () => {
  it("closes the sockets of the browsers it opened with 4401 on its own, and leaves the others connected", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] });
    try {
      const mine = await t.login();
      const authenticator = createSoftwareAuthenticator({ origin: t.origin, rpId: "localhost" });
      await enroll(t, authenticator, mine);
      const theirs = [await signInWithPasskey(t, authenticator), await signInWithPasskey(t, authenticator)];
      const owner = await t.connect(mine);
      const listed = await owner.call("auth.passkeys.list", {});
      if (!listed.ok) throw new Error("passkeys.list failed");
      const ref = (listed.result as { passkeys: Array<{ id: string }> }).passkeys[0]?.id ?? "";
      expect(ref).toMatch(/^[0-9a-f]{32}$/);
      expect((listed.result as { passkeys: unknown[] }).passkeys).toHaveLength(1);
      const sockets = await Promise.all(theirs.map((cookie) => t.connect(cookie)));
      await t.confirmStepUp(mine);

      // No request goes over the other sockets: the close is the daemon's, not an answer to a call.
      expect(await owner.call("auth.passkeys.remove", { passkeyId: ref })).toMatchObject({
        ok: true,
        result: { revoked: 2 },
      });
      expect(await Promise.all(sockets.map((socket) => socket.closed))).toEqual([4401, 4401]);
      for (const cookie of theirs) await expect(t.connect(cookie)).rejects.toThrow(/status 401/);
      // The browser that removed it, and its socket, stay.
      expect(await owner.call("sessions.list", {})).toMatchObject({ ok: true });
      expect(await owner.call("auth.passkeys.list", {})).toMatchObject({
        ok: true,
        result: { passkeys: [] },
      });
      const audit = rowsOf(await owner.call("audit.list", { limit: 200 }));
      expect(audit.find((row) => row.reason === "passkey_removed")).toMatchObject({
        kind: "auth",
        detail: { passkeyId: ref, count: 2 },
      });
    } finally {
      await t.stop();
    }
  }, 30_000);
});
