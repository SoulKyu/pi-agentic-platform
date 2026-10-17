import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemClock } from "./kernel/clock.ts";
import { createHttpsTransport, hostRules, loadVapid } from "./modules/push/index.ts";
import { decryptPayload } from "./modules/push/testing/decrypt.ts";
import { createTestBrowser, startFakePushService } from "./modules/push/testing/fake-push-service.ts";
import { subInput } from "./modules/push/testing/transport-bed.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

const script = { steps: [{ text: "hi" }] };
/** The harness fakes the sender by default; these tests are about the real one (`push: {}`). */
const REAL = { push: {} };
const METHODS = ["push.config", "push.subscribe", "push.list", "push.revoke"] as const;

async function mintToken(t: TestDaemon, cookie: string, owner: TestClient): Promise<string> {
  await t.confirmStepUp(cookie);
  const created = await owner.call("auth.tokens.create", {
    name: "ci",
    permissions: ["settings:read", "settings:operate"],
    expiresInDays: 7,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  return (created.result as { value: string }).value;
}

describe("push subscriptions through the production compose (M12 task 5)", () => {
  it("a browser subscribes, lists and revokes; a token is refused on every method; the key sits at 0600", async () => {
    const { logger, lines } = captureLogger();
    const t = await startTestDaemon(script, { deps: { logger, ...REAL } });
    try {
      const cookie = await t.login();
      const owner = await t.connect(cookie);
      const config = await owner.call("push.config", {});
      expect(config).toMatchObject({ ok: true, result: { status: "on", subscribed: 0, max: 10 } });
      expect((config as { result: { publicKey: string } }).result.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
      expect(statSync(join(t.home, "secrets", "push", "vapid.json")).mode & 0o777).toBe(0o600);

      const input = subInput(1, { endpoint: "https://web.push.apple.com/x/abcdefghijklmnop" });
      const subscribed = await owner.call("push.subscribe", { subscription: input });
      expect(subscribed).toMatchObject({ ok: true });
      const id = (subscribed as { result: { id: string } }).result.id;
      const listed = await owner.call("push.list", {});
      expect(listed).toMatchObject({
        ok: true,
        result: { items: [{ id, host: "web.push.apple.com", current: true }] },
      });
      expect(JSON.stringify(listed)).not.toContain("abcdefghijklmnop");
      expect(JSON.stringify(listed)).not.toContain(input.keys.p256dh);

      const bot = await t.connectBearer(await mintToken(t, cookie, owner));
      const params = {
        "push.config": {},
        "push.subscribe": { subscription: subInput(2) },
        "push.list": {},
        "push.revoke": { id },
      };
      for (const method of METHODS)
        expect(await bot.call(method, params[method]), method).toMatchObject({
          ok: false,
          error: { code: "forbidden" },
        });
      expect(await owner.call("push.list", {})).toMatchObject({ result: { items: [{ id }] } });

      expect(await owner.call("push.revoke", { id })).toMatchObject({ ok: true });
      expect(await owner.call("push.list", {})).toMatchObject({ ok: true, result: { items: [] } });
      expect(JSON.stringify(lines)).not.toContain("abcdefghijklmnop");
      expect(JSON.stringify(lines)).not.toContain(input.keys.auth);
    } finally {
      await t.stop();
    }
  });

  it("a restart with the key file gone purges the rows and says so in push.config (M12R4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pap-push-reset-"));
    try {
      const first = await startTestDaemon(script, { root, deps: REAL });
      let cookie: string;
      try {
        cookie = await first.login();
        const owner = await first.connect(cookie);
        expect(await owner.call("push.subscribe", { subscription: subInput(1) })).toMatchObject({ ok: true });
      } finally {
        await first.stop();
      }
      const keyFile = join(root, "home", "secrets", "push", "vapid.json");
      const home = existsSync(keyFile) ? keyFile : null;
      expect(home, "the key file lives under the daemon's home").not.toBeNull();
      rmSync(keyFile);
      const { logger, lines } = captureLogger();
      const second = await startTestDaemon(script, { root, deps: { logger, ...REAL } });
      try {
        const owner = await second.connect(cookie);
        expect(await owner.call("push.config", {})).toMatchObject({
          ok: true,
          result: { status: "on", subscribed: 0, keysReset: { purged: 1 } },
        });
        expect(lines.filter((line) => line.msg === "push_keys_reset")).toEqual([
          expect.objectContaining({ purged: 1 }),
        ]);
        await owner.call("push.subscribe", { subscription: subInput(2) });
        expect(await owner.call("push.config", {})).toMatchObject({
          result: { subscribed: 1, keysReset: null },
        });
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("with the loopback switch a subscription on a local service is accepted and the real transport reaches it; without the switch it is bad_request (M12R19)", async () => {
    const fake = await startFakePushService();
    const browser = createTestBrowser();
    const endpoint = `${fake.url}/push/int-endpoint-1`;
    const { logger, lines } = captureLogger();
    try {
      const off = await startTestDaemon(script, { deps: REAL });
      try {
        const owner = await off.connect(await off.login());
        expect(await owner.call("push.subscribe", { subscription: browser.input(endpoint) })).toMatchObject({
          ok: false,
          error: { code: "bad_request" },
        });
      } finally {
        await off.stop();
      }

      const t = await startTestDaemon(script, { config: { testPushLoopback: true }, deps: REAL });
      try {
        const owner = await t.connect(await t.login());
        const subscribed = await owner.call("push.subscribe", { subscription: browser.input(endpoint) });
        expect(subscribed).toMatchObject({ ok: true });
        const config = (await owner.call("push.config", {})) as {
          result: { publicKey: string; status: string };
        };
        expect(config.result.status).toBe("on");

        // the daemon's own key file, read back: the sender signs with the key that push.config advertises
        const vapid = loadVapid(join(t.home, "secrets"), logger);
        if (vapid.kind !== "ready") throw new Error("the daemon's key file must load");
        const transport = createHttpsTransport({
          vapid,
          subject: "https://pap.example.net",
          readiness: { status: "ready", origin: "https://pap.example.net" },
          clock: createSystemClock(),
          logger,
          loopbackForTests: true,
          hosts: hostRules([]),
        });
        const plaintext = Buffer.from('{"v":1,"id":"int","cls":"approval","title":"pap","body":"x","ts":1}');
        const outcome = await transport.send(
          browser.target(endpoint),
          plaintext,
          { ttlSeconds: 60, urgency: "normal", topic: "int-topic" },
          new AbortController().signal,
        );
        expect(outcome).toEqual({ kind: "ok" });
        expect(fake.requests).toHaveLength(1);
        const [request] = fake.requests;
        if (request === undefined) throw new Error("no request");
        expect(decryptPayload(request.body, browser.ecdh, browser.authSecret).equals(plaintext)).toBe(true);
        expect(request.headers.authorization).toContain(`, k=${config.result.publicKey}`);
        expect(JSON.stringify(lines)).not.toContain("int-endpoint-1");
      } finally {
        await t.stop();
      }
    } finally {
      await fake.close();
    }
  });
});
