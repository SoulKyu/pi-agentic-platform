// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import {
  alerts,
  statuses,
  button,
  click,
  hasButton,
  mount,
  settle,
  text,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { DevicesList } from "./DevicesList.tsx";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
const signOutHere = vi.fn();
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  signOutHere.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const device = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  current: false,
  browser: "firefox",
  os: "linux",
  ip: "10.0.0.2",
  method: "password",
  createdAt: Date.UTC(2026, 9, 1, 12),
  lastSeenAt: Date.UTC(2026, 9, 3, 12),
  expiresAt: Date.UTC(2026, 10, 1),
  ...over,
});
const three = [
  device("d1", { current: true, browser: "chrome", os: "macos", ip: "10.0.0.1", method: "passkey" }),
  device("d2"),
  device("d3", { browser: "safari", os: "ios", ip: null, method: null }),
];

async function show(devices: unknown[] = three) {
  bed.handlers["auth.devices.list"] = () => ({ devices });
  page = await mount(<DevicesList signOutHere={signOutHere} />);
  await settle();
  return page.container;
}

describe("connected devices", () => {
  it("lists browser and system translated, marks this browser, and shows address, method and dates", async () => {
    const container = await show();
    const rows = [...container.querySelectorAll("[data-device]")];
    expect(rows.map((row) => row.getAttribute("data-device"))).toEqual(["d1", "d2", "d3"]);
    const first = text(rows[0] as Element);
    expect(first).toContain("Chrome on macOS");
    expect(first).toContain("This browser");
    expect(first).toContain("10.0.0.1");
    expect(first).toContain("Passkey");
    expect(first).toContain(new Date(Date.UTC(2026, 9, 1, 12)).toLocaleString("en"));
    expect(first).toContain(new Date(Date.UTC(2026, 9, 3, 12)).toLocaleString("en"));
    expect(text(rows[1] as Element)).not.toContain("This browser");
    expect(text(rows[2] as Element)).toContain("Safari on iOS");
    expect(hasButton(rows[1] as Element, "Revoke Firefox on Linux")).toBe(true);
  });

  it("asks inline before revoking another device, then revokes with a commandId and reloads", async () => {
    const container = await show();
    await click(button(container, "Revoke Firefox on Linux"));
    expect(text(container)).toContain("Sign this device out?");
    expect(bed.called("auth.devices.revoke")).toEqual([]);
    bed.handlers["auth.devices.revoke"] = () => ({ ok: true });
    bed.handlers["auth.devices.list"] = () => ({ devices: [three[0], three[2]] });
    await click(button(container, "Sign out"));
    await settle();
    expect(bed.called("auth.devices.revoke")).toEqual([
      {
        method: "auth.devices.revoke",
        params: { deviceId: "d2" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(bed.called("auth.devices.list")).toHaveLength(2);
    expect(container.querySelectorAll("[data-device]")).toHaveLength(2);
    expect(signOutHere).not.toHaveBeenCalled();
    expect(text(container)).not.toContain("Sign this device out?");
  });

  it("cancels the inline question without a call", async () => {
    const container = await show();
    await click(button(container, "Revoke Firefox on Linux"));
    await click(button(container, "Cancel"));
    expect(text(container)).not.toContain("Sign this device out?");
    expect(bed.called("auth.devices.revoke")).toEqual([]);
  });

  it("runs the sign-out flow after revoking this browser", async () => {
    const container = await show();
    await click(button(container, "Revoke Chrome on macOS"));
    await click(button(container, "Sign out"));
    await settle();
    expect(bed.called("auth.devices.revoke")[0]?.params).toEqual({ deviceId: "d1" });
    expect(signOutHere).toHaveBeenCalledTimes(1);
  });

  it("keeps a failure on screen and does not sign out when the revoke is refused", async () => {
    const container = await show();
    bed.handlers["auth.devices.revoke"] = () => {
      throw new RpcError("not_found");
    };
    await click(button(container, "Revoke Chrome on macOS"));
    await click(button(container, "Sign out"));
    await settle();
    expect(alerts(container)).toEqual([
      "This item no longer exists: it was deleted, or the link is wrong. Nothing else was changed. Pick it again from its list.",
    ]);
    expect(signOutHere).not.toHaveBeenCalled();
  });

  it("signs out when the socket drops while revoking this browser, but not for another device", async () => {
    const container = await show();
    bed.handlers["auth.devices.revoke"] = () => {
      throw new RpcError("connection_lost");
    };
    await click(button(container, "Revoke Firefox on Linux"));
    await click(button(container, "Sign out"));
    await settle();
    expect(alerts(container)).toEqual([
      "The connection dropped before the answer arrived. The action may still have gone through: check before trying again.",
    ]);
    expect(signOutHere).not.toHaveBeenCalled();
    await click(button(container, "Revoke Chrome on macOS"));
    await click(button(container, "Sign out"));
    await settle();
    expect(signOutHere).toHaveBeenCalledTimes(1);
    expect(alerts(container)).toEqual([]);
  });

  it("shows the tokens line with its link before 'Sign out other devices' is confirmed, then reports the count", async () => {
    const container = await show();
    await click(button(container, "Sign out other devices"));
    expect(text(container)).toContain("API tokens keep working: revoke them under Tokens.");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("#tokens");
    expect(bed.called("auth.devices.revokeOthers")).toEqual([]);
    bed.handlers["auth.devices.revokeOthers"] = () => ({ revoked: 2 });
    await click(button(container, "Sign out others"));
    await settle();
    expect(bed.called("auth.devices.revokeOthers")).toEqual([
      { method: "auth.devices.revokeOthers", params: {}, options: { commandId: "bed-cmd-00000001" } },
    ]);
    expect(text(container)).toContain("2 devices signed out");
    expect(bed.called("auth.devices.list")).toHaveLength(2);
  });

  it("says one device in the singular and shows nothing wrong for none", async () => {
    const container = await show();
    bed.handlers["auth.devices.revokeOthers"] = () => ({ revoked: 1 });
    await click(button(container, "Sign out other devices"));
    await click(button(container, "Sign out others"));
    await settle();
    expect(text(container)).toContain("1 device signed out");
  });

  it("shows a load failure with a retry", async () => {
    bed.handlers["auth.devices.list"] = () => {
      throw new RpcError("offline");
    };
    page = await mount(<DevicesList signOutHere={signOutHere} />);
    await settle();
    const container = page.container;
    expect(statuses(container)).toEqual([
      "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
    ]);
    bed.handlers["auth.devices.list"] = () => ({ devices: three });
    await click(button(container, "Try again"));
    await settle();
    expect(container.querySelectorAll("[data-device]")).toHaveLength(3);
    expect(alerts(container)).toEqual([]);
  });

  it("drops the answer of a load that a newer load replaced", async () => {
    const container = await show();
    const waiting: Array<(value: unknown) => void> = [];
    bed.handlers["auth.devices.list"] = () => new Promise((resolve) => waiting.push(resolve));
    bed.handlers["auth.devices.revoke"] = () => ({ ok: true });
    bed.handlers["auth.devices.revokeOthers"] = () => ({ revoked: 0 });
    await click(button(container, "Revoke Firefox on Linux"));
    await click(button(container, "Sign out"));
    await settle();
    await click(button(container, "Sign out other devices"));
    await click(button(container, "Sign out others"));
    await settle();
    expect(waiting).toHaveLength(2);
    waiting[1]?.({ devices: [three[0]] });
    await settle();
    waiting[0]?.({ devices: three });
    await settle();
    expect(container.querySelectorAll("[data-device]")).toHaveLength(1);
  });
});
