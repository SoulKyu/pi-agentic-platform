import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../kernel/ids.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";
import { rowsOf } from "./testing/fixtures.ts";

// Spec C §8.1 over /ws: removing a passkey signs out the browsers it opened (M5R9), and their sockets close with 4401.
const PASSWORD = "correct horse battery staple";

async function signIn(t: TestDaemon): Promise<string> {
  const reply = await httpRequest(`${t.base}/auth/login`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  expect(reply.status).toBe(200);
  return reply.headers["set-cookie"]?.toString().split(";")[0] ?? "";
}

/**
 * A test-only write beside the running daemon (the single-writer rule is about the product): a passkey row, and the
 * link from the given browsers' sessions to it, as a passkey sign-in would have left them. A real assertion needs a
 * browser's authenticator.
 */
function enrollPasskey(t: TestDaemon, publicIds: string[]): string {
  const db = new DatabaseSync(join(t.home, "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const user = db.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
    expect(user).toHaveLength(1);
    db.prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, 0, '[]', 0)",
    ).run("credential-under-test", user[0]?.id ?? "", new Uint8Array([1, 2, 3]));
    // The short id the list shows (M5R128): the first 32 hex characters of the sha256 of the credential id.
    const ref = sha256Hex("credential-under-test").slice(0, 32);
    for (const publicId of publicIds) {
      expect(
        db.prepare("UPDATE auth_sessions SET passkey_ref = ? WHERE public_id = ?").run(ref, publicId).changes,
      ).toBe(1);
    }
    return ref;
  } finally {
    db.close();
  }
}

describe("security: a removed passkey signs its browsers out (daemon)", () => {
  it("closes the sockets of the browsers it opened with 4401 on its own, and leaves the others connected", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] });
    try {
      const mine = await t.login();
      const theirs = [await signIn(t), await signIn(t)];
      const owner = await t.connect(mine);
      const listed = await owner.call("auth.devices.list", {});
      if (!listed.ok) throw new Error("devices.list failed");
      const others = (listed.result as { devices: Array<{ id: string; current: boolean }> }).devices.filter(
        (device) => !device.current,
      );
      expect(others).toHaveLength(2);
      const ref = enrollPasskey(
        t,
        others.map((device) => device.id),
      );
      expect(await owner.call("auth.passkeys.list", {})).toMatchObject({
        ok: true,
        result: { passkeys: [{ id: ref }] },
      });
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
