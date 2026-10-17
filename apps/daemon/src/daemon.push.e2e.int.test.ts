import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, PUSH_ID, PushWire } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { decryptPayload } from "./modules/push/testing/decrypt.ts";
import {
  createTestBrowser,
  startFakePushService,
  type FakePushService,
  type TestBrowser,
} from "./modules/push/testing/fake-push-service.ts";
import { subInput } from "./modules/push/testing/transport-bed.ts";
import { rawCall, rawStep } from "./security/testing/raw-platform-extension.ts";
import { result, rows } from "./security/testing/automation-bed.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

// M12 J1 through a whole daemon: the real sender (not a fake transport) talks to a local fake push service. The loopback
// switch is the only way a local address is accepted (M12R19); no vendor host is named, no byte leaves 127.0.0.1.

const SCRIPT = { steps: [{ text: "unused" }] };
const SUBJECT = "https://pap.example.net";
const METHODS = [
  "push.config",
  "push.subscribe",
  "push.list",
  "push.revoke",
  "push.test",
  "push.presence",
] as const;

let fake: FakePushService;
let browser: TestBrowser;
let clock: FakeClock;
let root: string;
beforeEach(async () => {
  fake = await startFakePushService();
  browser = createTestBrowser();
  clock = createFakeClock();
  root = mkdtempSync(join(tmpdir(), "pap-push-e2e-"));
});
afterEach(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

/** A daemon with the real sender and the loopback switch; `loopback: false` is a restart without it. */
const start = (loopback: boolean, logger = captureLogger()) =>
  startTestDaemon(SCRIPT, {
    root,
    config: { testPushLoopback: loopback, pushSubject: SUBJECT },
    deps: { clock, logger: logger.logger, push: {} },
  });

const decode = (body: Buffer) =>
  PushWire.parse(JSON.parse(decryptPayload(body, browser.ecdh, browser.authSecret).toString()));
const claims = (authorization: string | undefined) =>
  JSON.parse(Buffer.from((authorization ?? "").split(".")[1] ?? "", "base64url").toString()) as {
    aud: string;
    sub: string;
    exp: number;
  };
const events = (t: TestDaemon, cls: string) =>
  rows<{ id: string; state: string; reason: string | null }>(
    t.home,
    "SELECT id, state, reason FROM push_events WHERE cls = ? ORDER BY rowid",
    cls,
  );

/** An agent in a thread whose worker sends a raw `agent.notify`: a live `agent_notify` Inbox item (no bwrap needed). */
async function notifyOnce(t: TestDaemon, client: TestClient, name = "Atlas"): Promise<void> {
  const created = result<{ id: string }>(
    await client.call("agents.create", {
      input: AgentInput.parse({ name, sandbox: { required: false } }),
    }),
  );
  // a worker reads its script once, when it starts: the thread's worker starts with openThread
  writeFileSync(join(t.root, "script.json"), JSON.stringify({ steps: [rawStep([rawCall("agent.notify")])] }));
  const { sessionId } = result<{ sessionId: string }>(
    await client.call("agents.openThread", { agentId: created.id }),
  );
  expect((await client.call("sessions.prompt", { sessionId, text: "go" })).ok).toBe(true);
  await vi.waitFor(() => expect(events(t, "notify")).toHaveLength(1), { timeout: 30_000 });
}

describe("subscribe-send-decrypt", () => {
  it("one agent_notify item is one request, sealed once, signed by the daemon's key; a 500 is retried; a 410 drops the row", async () => {
    const { logger, lines } = captureLogger();
    const t = await start(true, { logger, lines });
    try {
      const cookie = await t.login();
      await t.confirmStepUp(cookie);
      const owner = await t.connect(cookie);
      const endpoint = `${fake.url}/push/e2e-endpoint-secret`;
      const input = { ...browser.input(endpoint), locale: "fr" as const };
      expect(await owner.call("push.subscribe", { subscription: input })).toMatchObject({ ok: true });
      const config = result<{ publicKey: string; status: string; subscribed: number }>(
        await owner.call("push.config", {}),
      );
      expect(config).toMatchObject({ status: "on", subscribed: 1 });

      // A first answer of 500: the real sender reports a retry and the outbox backs off 5 s.
      fake.respondNext(500);
      await notifyOnce(t, owner);
      await clock.advance(0);
      await fake.received(1);
      await vi.waitFor(() => expect(events(t, "notify")[0]?.state).toBe("pending"));
      await clock.advance(5_000);
      await fake.received(2);
      await vi.waitFor(() => expect(events(t, "notify")[0]?.state).toBe("sent"));

      // Both requests are the same event: the retry carries the same topic.
      const [first, second] = fake.requests;
      if (first === undefined || second === undefined) throw new Error("two requests expected");
      const event = events(t, "notify")[0];
      expect(first.headers.topic).toBe(event?.id);
      expect(second.headers.topic).toBe(event?.id);
      // POLICY for `notify`: normal urgency, four hours.
      expect(second.headers).toMatchObject({
        urgency: "normal",
        ttl: "14400",
        "content-encoding": "aes128gcm",
      });
      expect(second.headers.authorization).toContain(`, k=${config.publicKey}`);
      expect(claims(second.headers.authorization)).toMatchObject({ aud: fake.url, sub: SUBJECT });

      // Exactly one encryption layer: it decrypts once to the wire, generic text in the subscriber's language.
      const wire = decode(second.body);
      expect(wire).toMatchObject({
        v: 1,
        cls: "notify",
        title: "pap",
        body: "Un agent a un message pour vous.",
      });
      expect(wire.id).toBe(event?.id);
      expect(wire.id).toMatch(PUSH_ID);
      expect(JSON.stringify(wire)).not.toContain("Atlas");
      const opened = result<{ target: { kind: string; id: string | null } }>(
        await owner.call("push.open", { id: wire.id }),
      );
      expect(opened.target.kind).toBe("inbox");

      // A 410 from the service drops the row: push.test answers from the transport itself.
      fake.respondNext(410);
      expect(await owner.call("push.test", {})).toMatchObject({
        ok: true,
        result: { delivered: 0, dropped: 1 },
      });
      expect(result<{ items: unknown[] }>(await owner.call("push.list", {})).items).toHaveLength(0);
      expect(JSON.stringify(lines)).not.toContain("e2e-endpoint-secret");
      expect(JSON.stringify(lines)).not.toContain(browser.p256dh);
      expect(JSON.stringify(lines)).not.toContain(fake.requests[0]?.body.toString("base64url") ?? "-");
    } finally {
      await t.stop();
    }
  }, 120_000);

  it("a restart without the loopback switch refuses the stored local endpoint at send time", async () => {
    const first = await start(true);
    let cookie!: string;
    try {
      cookie = await first.login();
      const owner = await first.connect(cookie);
      expect(
        await owner.call("push.subscribe", { subscription: browser.input(`${fake.url}/push/restart-1`) }),
      ).toMatchObject({ ok: true });
    } finally {
      await first.stop();
    }
    const second = await start(false);
    try {
      const owner = await second.connect(cookie);
      // the sender re-runs the endpoint rules at send time: the stored local address is refused, nothing is dialled
      expect(await owner.call("push.test", {})).toMatchObject({
        ok: true,
        result: { delivered: 0, dropped: 0 },
      });
      expect(
        rows<{ state: string; reason: string | null }>(second.home, "SELECT state, reason FROM push_events"),
      ).toEqual([{ state: "failed", reason: "undelivered" }]);
      expect(fake.requests).toHaveLength(0);
      expect(fake.connections()).toBe(0);
    } finally {
      await second.stop();
    }
  }, 60_000);
});

describe("revoke-sticks (W6-R15)", () => {
  it("a revoked device that opens pap again is refused with push_revoked; Enable on a new endpoint is accepted", async () => {
    const t = await start(true);
    try {
      const owner = await t.connect(await t.login());
      const device = browser.input(`${fake.url}/push/revoke-1`);
      const { id } = result<{ id: string }>(await owner.call("push.subscribe", { subscription: device }));
      expect(await owner.call("push.revoke", { id })).toMatchObject({ ok: true });
      // the next open of the same browser subscription refreshes it: refused, nothing is stored
      await clock.advance(6_000); // the first subscribe used the window
      expect(await owner.call("push.subscribe", { subscription: device })).toMatchObject({
        ok: false,
        error: { code: "push_revoked" },
      });
      expect(result<{ items: unknown[] }>(await owner.call("push.list", {})).items).toEqual([]);
      // Enable right after the refusal, no clock advance: the refusal did not use the window
      expect(
        await owner.call("push.subscribe", { subscription: browser.input(`${fake.url}/push/revoke-2`) }),
      ).toMatchObject({ ok: true });
      expect(result<{ items: unknown[] }>(await owner.call("push.list", {})).items).toHaveLength(1);
    } finally {
      await t.stop();
    }
  }, 60_000);
});

describe("token-cannot", () => {
  it("a token is forbidden on every push method, gets no presence and cannot write the notifications document", async () => {
    const t = await start(true);
    try {
      const cookie = await t.login();
      await t.confirmStepUp(cookie);
      const owner = await t.connect(cookie);
      const created = result<{ value: string }>(
        await owner.call("auth.tokens.create", {
          name: "ci",
          permissions: ["settings:read", "settings:operate", "inbox:read", "inbox:operate"],
          expiresInDays: 7,
        }),
      );
      const bot = await t.connectBearer(created.value);
      const params = {
        "push.config": {},
        "push.subscribe": { subscription: subInput(1) },
        "push.list": {},
        "push.revoke": { id: "x" },
        "push.test": {},
        "push.presence": { focused: true },
      };
      for (const method of METHODS)
        expect(await bot.call(method, params[method]), method).toMatchObject({
          ok: false,
          error: { code: "forbidden" },
        });
      expect(await bot.call("push.open", { id: "a".repeat(22) })).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
      // The Inbox is readable by the token; it holds no presence and no push state.
      const listed = await bot.call("inbox.list", {});
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed)).not.toMatch(/focused|presence|endpoint/);
      const current = result<{ revision: number }>(
        await owner.call("settings.get", { key: "notifications" }),
      );
      const write = await bot.call("settings.set", {
        key: "notifications",
        value: { classes: {}, muteUntil: null, titles: "names" },
        baseRevision: current.revision,
      } as never);
      expect(write.ok).toBe(false);
      expect(
        result<{ value: unknown }>(await owner.call("settings.get", { key: "notifications" })).value,
      ).toBeNull();
    } finally {
      await t.stop();
    }
  }, 60_000);
});

describe("keys", () => {
  const keyFile = () => join(root, "home", "secrets", "push", "vapid.json");
  const config = async (t: TestDaemon, cookie: string) =>
    result<{
      status: string;
      reason: string | null;
      subscribed: number;
      keysReset: { purged: number } | null;
    }>(await (await t.connect(cookie)).call("push.config", {}));

  it("a first boot makes the key 0600 in 0700, a second keeps it, a damaged file keeps push off and purges nothing", async () => {
    const first = await start(true);
    let cookie!: string;
    let publicKey!: string;
    try {
      cookie = await first.login();
      const owner = await first.connect(cookie);
      expect(
        await owner.call("push.subscribe", { subscription: browser.input(`${fake.url}/push/keys-1`) }),
      ).toMatchObject({ ok: true });
      publicKey = result<{ publicKey: string }>(await owner.call("push.config", {})).publicKey;
      expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "home", "secrets", "push")).mode & 0o777).toBe(0o700);
    } finally {
      await first.stop();
    }
    const second = await start(true);
    try {
      const owner = await second.connect(cookie);
      expect(
        result<{ publicKey: string; subscribed: number }>(await owner.call("push.config", {})),
      ).toMatchObject({
        publicKey,
        subscribed: 1,
      });
    } finally {
      await second.stop();
    }
    writeFileSync(keyFile(), "{ not json", { mode: 0o600 });
    const third = await start(true);
    try {
      expect(await config(third, cookie)).toMatchObject({
        status: "off",
        reason: "keys_unreadable",
        keysReset: null,
      });
      expect(rows<{ n: number }>(third.home, "SELECT count(*) AS n FROM push_subs")[0]?.n).toBe(1);
      expect(
        await (
          await third.connect(cookie)
        ).call("push.subscribe", { subscription: browser.input(`${fake.url}/push/keys-2`) }),
      ).toMatchObject({
        ok: false,
      });
      // a damaged file is not overwritten
      expect(statSync(keyFile()).size).toBe("{ not json".length);
    } finally {
      await third.stop();
    }
  }, 90_000);

  it("a missing file is a plain restore: the old rows are purged, push.config says how many, a new device clears it", async () => {
    const first = await start(true);
    let cookie!: string;
    try {
      cookie = await first.login();
      const owner = await first.connect(cookie);
      await owner.call("push.subscribe", { subscription: browser.input(`${fake.url}/push/restore-1`) });
    } finally {
      await first.stop();
    }
    rmSync(keyFile());
    const second = await start(true);
    try {
      expect(await config(second, cookie)).toMatchObject({
        status: "on",
        subscribed: 0,
        keysReset: { purged: 1 },
      });
      const owner = await second.connect(cookie);
      await owner.call("push.subscribe", { subscription: browser.input(`${fake.url}/push/restore-2`) });
      expect(await config(second, cookie)).toMatchObject({ subscribed: 1, keysReset: null });
    } finally {
      await second.stop();
    }
  }, 60_000);
});
