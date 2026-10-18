/// <reference lib="dom" />
// J13 (Chromium only, M13R6): a device enables notifications, then an approval waits and a push reaches the sink with the
// generic lock-screen sentence and nothing of the command; a second test disables the device and a later approval sends
// nothing. The browser has no push service here, so an init script replaces PushManager.subscribe and
// Notification.requestPermission with stubs that answer with a subscription whose endpoint is the sink (the daemon takes a
// loopback endpoint only with PAP_TEST_PUSH_LOOPBACK=1). Presence (R43): an approval is enqueued at +60 s and suppressed
// while a device is present, a heartbeat under 45 s old; a focused page keeps sending them, so each test closes its page
// before the approval is raised, from a node-side client, and then waits for the daemon's real clock.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";
import type { PapInstance } from "./fixtures.ts";
import { type PushSink, startPushSink } from "./push-sink.ts";
import { dbRows } from "./seed.ts";

const COMMAND_MARKER = "e2e-j13-secret-marker";
// The wording of the daemon's push copy for an approval (apps/daemon/src/modules/push/delivery/copy.ts, English).
const GENERIC_BODY = "A request is waiting for your answer.";
const WAIT_MS = 100_000; // R43: the push needs 60 to 70 s after the last heartbeat

test.use({
  papEnv: { PAP_TEST_PUSH_LOOPBACK: "1" },
  papScript: scripted([
    { toolCalls: [{ name: "bash", id: "j13-bash", args: { command: `env echo ${COMMAND_MARKER}` } }] },
    { text: "done" },
  ]),
});
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "push is exercised on Chromium only: WebKit has no push service to stub (M13R6)",
);

// Started once for the file; a project where every test is skipped (WebKit) never runs the hooks.
const started: PushSink[] = [];
test.beforeAll(async () => {
  started.push(await startPushSink());
});
test.afterAll(async () => {
  await Promise.all(started.splice(0).map((one) => one.close()));
});
const sinkOf = (): PushSink => {
  const [one] = started;
  if (!one) throw new Error("the push sink did not start");
  return one;
};

/** The subscription the page's push manager hands out, kept in localStorage so a reload still holds it. */
async function stubPush(context: BrowserContext, sink: PushSink) {
  await context.addInitScript(
    ({ endpoint: url, keys: pair }) => {
      const STORE = "e2e-push-subscription";
      const make = (serverKey: number[] | null) => ({
        options: { applicationServerKey: serverKey ? new Uint8Array(serverKey).buffer : null },
        toJSON: () => ({ endpoint: url, keys: pair }),
        unsubscribe: async () => {
          localStorage.removeItem(STORE);
          return true;
        },
      });
      const held = (): number[] | null | undefined => {
        const text = localStorage.getItem(STORE);
        return text === null ? undefined : (JSON.parse(text) as number[] | null);
      };
      const manager = PushManager.prototype as unknown as Record<string, unknown>;
      manager["subscribe"] = async (options?: { applicationServerKey?: BufferSource | null }) => {
        const key = options?.applicationServerKey;
        const bytes = key ? Array.from(new Uint8Array(ArrayBuffer.isView(key) ? key.buffer : key)) : null;
        localStorage.setItem(STORE, JSON.stringify(bytes));
        return make(bytes);
      };
      manager["getSubscription"] = async () => {
        const key = held();
        return key === undefined ? null : make(key);
      };
      // Headless Chromium reports the permission as denied, and the page reads it before it asks.
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
    },
    { endpoint: `${sink.url}/push/e2e`, keys: { p256dh: sink.keys.p256dh, auth: sink.keys.auth } },
  );
}

const devicesOf = async (pap: PapInstance) =>
  (await pap.rpc<{ items: { id: string; current: boolean }[] }>("push.list")).items;

/** An approval raised from outside the page: a session whose first step is a command that waits for the owner. */
async function raiseApproval(pap: PapInstance): Promise<string> {
  const { sessionId } = await pap.rpc<{ sessionId: string }>("sessions.create", { cwd: pap.work });
  await pap.rpc("sessions.prompt", { sessionId, text: "Run the command." });
  return sessionId;
}

const eventOf = (pap: PapInstance, sessionId: string) =>
  dbRows<{ state: string; reason: string | null }>(
    pap,
    "SELECT state, reason FROM push_events WHERE cls = 'approval' AND ref_id = ?",
    sessionId,
  );

async function openNotifications(page: Page, pap: PapInstance): Promise<void> {
  await page.goto(`${pap.origin}/settings/notifications`);
  await expect(page.getByText(t("notifications.status.on"), { exact: true })).toBeVisible();
}

test("J13: an approval that waits sends one push with the generic sentence", async ({
  page,
  pap,
  signedIn,
}) => {
  test.setTimeout(150_000); // R43
  const sink = sinkOf();
  await stubPush(page.context(), sink);
  await openNotifications(signedIn, pap);

  await test.step("Enable lists this device", async () => {
    const enable = page.getByRole("button", { name: t("notifications.enable"), exact: true });
    await expect(enable).toBeEnabled();
    await enable.click();
    await expect(page.getByText(t("notifications.devices.current"), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("notifications.disable"), exact: true })).toBeVisible();
  });
  expect(await devicesOf(pap)).toHaveLength(1);

  // No heartbeat from now on: a focused page would keep the device present and suppress the push.
  await page.close();
  const sessionId = await raiseApproval(pap);

  await test.step("the push arrives once, encrypted for the sink's key", async () => {
    await expect
      .poll(() => sink.received().length, {
        message: "the sink receives a push",
        timeout: WAIT_MS,
        intervals: [2_000],
      })
      .toBeGreaterThan(0);
    const hits = sink.received();
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit?.path).toBe("/push/e2e");
    expect(hit?.headers["content-encoding"]).toBe("aes128gcm");
    expect(hit?.headers["authorization"]).toMatch(/^vapid /);
    const payload = JSON.parse(hit ? sink.keys.decrypt(hit) : "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 1, cls: "approval", title: "pap", body: GENERIC_BODY });
    // Never the command, the session or a path: the lock screen shows one fixed sentence.
    expect(JSON.stringify(payload)).not.toContain(COMMAND_MARKER);
    expect(JSON.stringify(payload)).not.toContain(sessionId);
  });
  expect(eventOf(pap, sessionId)).toEqual([{ state: "sent", reason: null }]);
});

test("J13: after Disable a later approval sends nothing", async ({ context, pap, signedIn }) => {
  test.setTimeout(150_000); // R43: its own wait for the daemon's clock
  const page = signedIn;
  const sink = sinkOf();
  await stubPush(context, sink);
  expect(await devicesOf(pap)).toHaveLength(1); // the first test's device
  await openNotifications(page, pap);

  await test.step("Disable removes the device", async () => {
    await page.getByRole("button", { name: t("notifications.disable"), exact: true }).click();
    await expect(page.getByText(t("notifications.devices.empty"), { exact: true })).toBeVisible();
  });
  expect(await devicesOf(pap)).toEqual([]);

  await page.close();
  const before = sink.received().length;
  const sessionId = await raiseApproval(pap);

  // The daemon judged the approval at +60 s (nobody to send to); only then is the silence of the sink meaningful.
  await expect
    .poll(() => eventOf(pap, sessionId), {
      message: "the approval is judged",
      timeout: WAIT_MS,
      intervals: [2_000],
    })
    .toEqual([{ state: "cancelled", reason: "no_target" }]);
  expect(sink.received()).toHaveLength(before);
});
