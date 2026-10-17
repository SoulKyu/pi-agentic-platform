// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { usePwa } from "../../stores/pwa.ts";
import { FakeSubscription, fakePushEnv, SERVER_PUBLIC_KEY } from "../../testing/push-env.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { config, device, NOW, notificationsBed, openPanel as open } from "../../testing/notifications-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let s: ReturnType<typeof notificationsBed>;
let bed: ReturnType<typeof notificationsBed>["bed"];
beforeEach(() => {
  s = notificationsBed();
  bed = s.bed;
  current.runtime = bed.runtime;
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("NotificationsPanel: status and device", () => {
  it("shows the active state, the cap line only at the cap, and the three devices", async () => {
    const { page } = await open();
    expect(text(page.container)).toContain("Notifications active");
    expect(text(page.container)).not.toContain("devices at most");
    expect(page.container.querySelectorAll("[data-device]")).toHaveLength(3);
    expect(page.container.querySelectorAll("[data-device] [data-slot=chip]")).toHaveLength(1);
    expect(text(page.container)).toContain("This device");
    expect(button(page.container, "Disable")).toBeTruthy();
  });

  it("at the cap with no device here, the button is replaced by the explanation", async () => {
    s.cfg = config({ subscribed: 10, max: 10 });
    s.devices = [device("b"), device("c")];
    const { page } = await open();
    expect(text(page.container)).toContain("10 devices at most");
    expect(hasButton(page.container, "Enable on this device")).toBe(false);
  });

  it("plain HTTP: the HTTPS sentence, the hint, and the enable button disabled", async () => {
    s.cfg = config({
      status: "off",
      reason: "insecure_http",
      readiness: { status: "insecure_http", hint: "Open pap over HTTPS." },
      subscribed: 0,
    });
    s.devices = [];
    const { page } = await open({ env: fakePushEnv({ support: () => "insecure" }).env });
    expect(text(page.container)).toContain("Notifications and installation need HTTPS.");
    expect(text(page.container)).toContain("Open pap over HTTPS.");
    expect(button(page.container, "Enable on this device").disabled).toBe(true);
  });

  it("keys unreadable: the reason, and no enabling", async () => {
    s.cfg = config({ status: "off", reason: "keys_unreadable", subscribed: 0 });
    s.devices = [];
    const { page } = await open();
    expect(text(page.container)).toContain("the notification keys cannot be read");
    expect(button(page.container, "Enable on this device").disabled).toBe(true);
  });

  it("iOS tab: the install instruction", async () => {
    s.cfg = config({ subscribed: 0 });
    s.devices = [];
    const { page } = await open({ env: fakePushEnv({ support: () => "needs_install_ios" }).env });
    expect(text(page.container)).toContain("Add pap to the home screen");
    expect(button(page.container, "Enable on this device").disabled).toBe(true);
  });

  it("shows the reset notice and the last failure class, never a body", async () => {
    s.cfg = config({
      keysReset: { at: NOW, purged: 2 },
      lastFailure: { at: NOW, reason: "rejected" },
    });
    const { page } = await open();
    expect(text(page.container)).toContain("Notifications were reset: each device turns them back on");
    expect(text(page.container)).toContain("Last delivery failure: the push service rejected the message");
  });

  it("answers in French with vous", async () => {
    setLocale("fr");
    s.cfg = config({ keysReset: { at: NOW, purged: 1 }, lastFailure: { at: NOW, reason: "refused" } });
    const { page } = await open();
    expect(text(page.container)).toContain("Notifications actives");
    expect(text(page.container)).toContain(
      "Les notifications ont été réinitialisées : chaque appareil les réactive à sa prochaine ouverture de pap.",
    );
    expect(text(page.container)).toContain("Dernier échec d'envoi :");
    expect(text(page.container)).toContain(
      "Seul le nom que vous avez donné au déclencheur ou à l'agent s'affiche. Jamais le contenu : ni commande, ni chemin, ni message, ni titre de tâche.",
    );
    expect(button(page.container, "Désactiver")).toBeTruthy();
  });
});

describe("NotificationsPanel: this device", () => {
  it("enable runs the click-time subscription and refreshes the list", async () => {
    s.cfg = config({ subscribed: 0 });
    s.devices = [];
    bed.handlers["push.subscribe"] = () => {
      s.devices = [device("n", { current: true })];
      return { id: "n" };
    };
    const { page, push } = await open();
    await click(button(page.container, "Enable on this device"));
    await settle();
    expect(push.requestPermission).toHaveBeenCalledTimes(1);
    expect(bed.called("push.subscribe")).toHaveLength(1);
    expect(button(page.container, "Disable")).toBeTruthy();
  });

  it("a refused enable shows the sentence and keeps the button", async () => {
    s.cfg = config({ subscribed: 0 });
    s.devices = [];
    bed.handlers["push.subscribe"] = () => {
      throw new RpcError("capacity");
    };
    const { page } = await open();
    await click(button(page.container, "Enable on this device"));
    await settle();
    expect(text(page.container)).toContain("This account already has the most devices it can hold.");
    expect(hasButton(page.container, "Enable on this device")).toBe(true);
  });

  it("disable revokes this device's row, then drops the browser subscription", async () => {
    const sub = new FakeSubscription();
    const push = fakePushEnv({}, sub);
    push.state.permission = "granted";
    const { page } = await open({ env: push.env });
    await click(button(page.container, "Disable"));
    await settle();
    expect(bed.called("push.revoke").map((entry) => entry.params)).toEqual([{ id: "a" }]);
    expect(sub.unsubscribed).toBe(1);
    expect(page.container.querySelectorAll("[data-device]")).toHaveLength(2);
  });

  it("enable refused with rate_limited keeps the subscription; Re-enable then reuses it", async () => {
    s.cfg = config({ subscribed: 0 });
    s.devices = [];
    let limited = true;
    bed.handlers["push.subscribe"] = () => {
      if (limited) throw new RpcError("rate_limited");
      s.devices = [device("n", { current: true })];
      return { id: "n" };
    };
    const { page, push } = await open();
    await click(button(page.container, "Enable on this device"));
    await settle();
    expect(push.subscribeCalls).toHaveLength(1);
    expect(hasButton(page.container, "Enable on this device")).toBe(false);
    limited = false;
    await click(button(page.container, "Re-enable notifications"));
    await settle();
    expect(push.subscribeCalls).toHaveLength(1);
    expect(bed.called("push.subscribe")).toHaveLength(2);
    expect(button(page.container, "Disable")).toBeTruthy();
  });

  it("disable says so when the revoke fails, and still drops the browser subscription", async () => {
    const sub = new FakeSubscription();
    const push = fakePushEnv({}, sub);
    bed.handlers["push.revoke"] = () => {
      throw new RpcError("internal");
    };
    const { page } = await open({ env: push.env });
    await click(button(page.container, "Disable"));
    await settle();
    expect(text(page.container)).toContain("The device could not be revoked.");
    expect(sub.unsubscribed).toBe(1);
  });

  it("a browser subscription with no row offers the one-tap re-enable", async () => {
    s.devices = [device("b")];
    s.cfg = config({ subscribed: 1 });
    const push = fakePushEnv({}, new FakeSubscription());
    push.state.permission = "granted";
    bed.handlers["push.subscribe"] = () => {
      s.devices = [device("n", { current: true })];
      return { id: "n" };
    };
    const { page } = await open({ env: push.env });
    expect(hasButton(page.container, "Enable on this device")).toBe(false);
    await click(button(page.container, "Re-enable notifications"));
    await settle();
    expect(bed.called("push.subscribe")).toHaveLength(1);
    expect(button(page.container, "Disable")).toBeTruthy();
  });

  it("pwa.needsReenable shows the same one-tap button", async () => {
    s.cfg = config({ subscribed: 0 });
    s.devices = [];
    usePwa.getState().setNeedsReenable(true);
    const { page } = await open();
    expect(button(page.container, "Re-enable notifications")).toBeTruthy();
  });
});

describe("NotificationsPanel: devices", () => {
  it("revoke asks first, naming the device, and sends nothing until confirmed", async () => {
    const { page } = await open();
    await click(button(page.container, "Revoke Device b"));
    expect(text(page.container)).toContain(
      "Revoke Device b? It stops receiving notifications until you enable them again on that device.",
    );
    expect(bed.called("push.revoke")).toHaveLength(0);
    await click(button(page.container, "Cancel"));
    expect(text(page.container)).not.toContain("It stops receiving notifications until");
    expect(document.activeElement).toBe(button(page.container, "Revoke Device b"));
    await click(button(page.container, "Revoke Device b"));
    await click(button(page.container, "Yes, revoke"));
    await settle();
    expect(bed.called("push.revoke").map((entry) => entry.params)).toEqual([{ id: "b" }]);
    expect(page.container.querySelectorAll("[data-device]")).toHaveLength(2);
  });

  it("a failed revoke says so and keeps the row", async () => {
    bed.handlers["push.revoke"] = () => {
      throw new RpcError("not_found");
    };
    const { page } = await open();
    await click(button(page.container, "Revoke Device b"));
    await click(button(page.container, "Yes, revoke"));
    await settle();
    expect(text(page.container)).toContain("The device could not be revoked.");
  });

  it("test: disables while pending, then shows delivered and dropped", async () => {
    let finish: (value: unknown) => void = () => {};
    bed.handlers["push.test"] = () => new Promise((resolve) => (finish = resolve));
    const { page } = await open();
    await click(button(page.container, "Send a test notification"));
    expect(button(page.container, "Send a test notification").disabled).toBe(true);
    await act(async () => finish({ delivered: 2, dropped: 1 }));
    await settle();
    expect(button(page.container, "Send a test notification").disabled).toBe(false);
    expect(text(page.container)).toContain("Test sent: 2 delivered to the push service, 1 dropped.");
  });

  it("test: a rate-limited answer says to wait", async () => {
    bed.handlers["push.test"] = () => {
      throw new RpcError("rate_limited");
    };
    const { page } = await open();
    await click(button(page.container, "Send a test notification"));
    await settle();
    expect(text(page.container)).toContain("Wait a few seconds before sending another test.");
  });

  it("renders hostile labels as text and never an endpoint or a key", async () => {
    s.devices = [
      device("a", { label: "<img src=x onerror=alert(1)>", current: true }),
      device("b", { label: "Pho\u202ene", host: "web.push.apple.com" }),
    ];
    const { page } = await open();
    expect(page.container.querySelector("img")).toBeNull();
    expect(text(page.container)).toContain("<img src=x onerror=alert(1)>");
    expect(page.container.innerHTML).not.toContain("\u202e");
    expect(page.container.innerHTML).not.toContain("https://");
    expect(page.container.innerHTML).not.toContain(SERVER_PUBLIC_KEY);
    expect(page.container.innerHTML).toContain("web.push.apple.com");
  });

  it("stacks each device on a phone-width screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767.98px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { page } = await open();
    const list = page.container.querySelector("[data-devices]");
    expect(list?.getAttribute("data-layout")).toBe("stacked");
  });
});

describe("NotificationsPanel: loading", () => {
  it("a failed read shows an alert and a retry that reads again", async () => {
    let fail = true;
    bed.handlers["push.config"] = () => {
      if (fail) throw new RpcError("internal");
      return s.cfg;
    };
    const { page } = await open();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The notification settings could not be loaded.",
    );
    fail = false;
    await click(button(page.container, "Try again"));
    await settle();
    expect(text(page.container)).toContain("Notifications active");
  });
});
