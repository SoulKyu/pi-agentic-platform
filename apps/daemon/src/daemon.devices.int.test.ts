import { describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { httpRequest } from "./testing/http-client.ts";

const script = { steps: [{ text: "hi" }] };

async function secondLogin(t: TestDaemon): Promise<string> {
  const reply = await httpRequest(`${t.base}/auth/login`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
  });
  if (reply.status !== 200) throw new Error(`login failed: ${reply.status}`);
  const header = reply.headers["set-cookie"];
  return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
}

describe("connected devices", () => {
  it("lists both browsers, and signing out the others closes the other socket with 4401 while this one stays", async () => {
    const t = await startTestDaemon(script);
    try {
      const first = await t.login();
      const second = await secondLogin(t);
      const mine = await t.connect(first);
      const theirs = await t.connect(second);
      const listed = await mine.call("auth.devices.list", {});
      if (!listed.ok) throw new Error("list failed");
      const devices = (listed.result as { devices: Array<{ id: string; current: boolean; method: string }> })
        .devices;
      expect(devices.map((d) => [d.current, d.method]).sort()).toEqual([
        [false, "password"],
        [true, "setup"],
      ]);
      expect(JSON.stringify(devices)).not.toContain(first.replace("pap_session=", ""));
      expect(await mine.call("auth.devices.revokeOthers", {})).toMatchObject({
        ok: true,
        result: { revoked: 1 },
      });
      expect(await theirs.call("sessions.list", {})).toMatchObject({
        ok: false,
        error: { code: "unauthenticated" },
      });
      expect(await theirs.closed).toBe(4401);
      expect(await mine.call("sessions.list", {})).toMatchObject({ ok: true });
      await expect(t.connect(second)).rejects.toThrow(/status 401/);
    } finally {
      await t.stop();
    }
  });

  it("revoking one device closes its socket; revoking this browser signs it out; an unknown id is not_found", async () => {
    const t = await startTestDaemon(script);
    try {
      const first = await t.login();
      const second = await secondLogin(t);
      const mine = await t.connect(first);
      const theirs = await t.connect(second);
      const listed = await mine.call("auth.devices.list", {});
      if (!listed.ok) throw new Error("list failed");
      const devices = (listed.result as { devices: Array<{ id: string; current: boolean }> }).devices;
      const other = devices.find((d) => !d.current)?.id ?? "";
      const self = devices.find((d) => d.current)?.id ?? "";
      expect(await mine.call("auth.devices.revoke", { deviceId: "f".repeat(32) })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(await mine.call("auth.devices.revoke", { deviceId: other })).toMatchObject({ ok: true });
      expect(await theirs.closed).toBe(4401);
      expect(await mine.call("auth.devices.revoke", { deviceId: self })).toMatchObject({ ok: true });
      expect(await mine.call("sessions.list", {})).toMatchObject({
        ok: false,
        error: { code: "unauthenticated" },
      });
      expect(await mine.closed).toBe(4401);
    } finally {
      await t.stop();
    }
  });
});
