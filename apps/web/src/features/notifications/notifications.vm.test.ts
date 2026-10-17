import type { PushConfig, PushDeviceView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  deviceRows,
  MUTE_FOREVER,
  mutePreset,
  muteUntilOf,
  statusView,
  type StatusFacts,
} from "./notifications.vm.ts";

const config = (over: Partial<PushConfig> = {}): PushConfig => ({
  publicKey: "key",
  status: "on",
  reason: null,
  readiness: { status: "ready" },
  subscribed: 1,
  max: 10,
  lastFailure: null,
  keysReset: null,
  ...over,
});
const device = (over: Partial<PushDeviceView> = {}): PushDeviceView => ({
  id: "d1",
  label: "iPhone",
  host: "web.push.apple.com",
  createdAt: 1_000,
  lastOkAt: null,
  current: false,
  ...over,
});
const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  config: config(),
  devices: [],
  support: "supported",
  browserSubscribed: false,
  needsReenable: false,
  ...over,
});

describe("statusView", () => {
  it("on, no subscription here: the enable button is live", () => {
    const view = statusView(facts());
    expect(view.line).toEqual({ key: "notifications.status.on", tone: "ok" });
    expect(view).toMatchObject({ action: "enable", actionDisabled: false, notes: [], capacity: null });
  });

  it("this device is registered: the button turns off", () => {
    const view = statusView(
      facts({
        config: config({ subscribed: 3 }),
        devices: [device({ current: true }), device({ id: "d2" })],
      }),
    );
    expect(view.action).toBe("disable");
    expect(view.current?.id).toBe("d1");
  });

  it("off with keys_unreadable names the reason and disables enabling", () => {
    const view = statusView(facts({ config: config({ status: "off", reason: "keys_unreadable" }) }));
    expect(view.line).toEqual({ key: "notifications.status.off.keys_unreadable", tone: "off" });
    expect(view).toMatchObject({ action: "enable", actionDisabled: true });
  });

  it("off read_only names the reason", () => {
    const view = statusView(facts({ config: config({ status: "off", reason: "read_only" }) }));
    expect(view.line.key).toBe("notifications.status.off.read_only");
    expect(view.actionDisabled).toBe(true);
  });

  it("off without a reason says only that it is off", () => {
    expect(statusView(facts({ config: config({ status: "off" }) })).line.key).toBe(
      "notifications.status.off",
    );
  });

  it("plain HTTP: the HTTPS sentence, the readiness hint, the button disabled (M12R16)", () => {
    const view = statusView(
      facts({
        config: config({
          status: "off",
          reason: "insecure_http",
          readiness: { status: "insecure_http", hint: "Open pap over HTTPS." },
        }),
        support: "insecure",
      }),
    );
    expect(view.line.key).toBe("push.support.insecure");
    expect(view.hint).toBe("Open pap over HTTPS.");
    expect(view).toMatchObject({ action: "enable", actionDisabled: true });
  });

  it("a hint is shown only while the origin is not ready", () => {
    expect(
      statusView(facts({ config: config({ readiness: { status: "ready", hint: "x" } }) })).hint,
    ).toBeNull();
    expect(
      statusView(facts({ config: config({ readiness: { status: "localhost_only", hint: "Only here." } }) }))
        .hint,
    ).toBe("Only here.");
  });

  it("cap reached with no device here: an explanation instead of the button", () => {
    const view = statusView(facts({ config: config({ subscribed: 10, max: 10 }) }));
    expect(view.capacity).toEqual({ max: 10 });
    expect(view.action).toBe("none");
  });

  it("cap reached but this device is one of them: it can still disable", () => {
    const view = statusView(
      facts({ config: config({ subscribed: 10, max: 10 }), devices: [device({ current: true })] }),
    );
    expect(view.capacity).toEqual({ max: 10 });
    expect(view.action).toBe("disable");
  });

  it("iOS in a tab: the install instruction, the button disabled", () => {
    const view = statusView(facts({ support: "needs_install_ios" }));
    expect(view.notes).toEqual(["push.support.needs_install_ios"]);
    expect(view).toMatchObject({ action: "enable", actionDisabled: true });
  });

  it("denied permission: the browser settings sentence, the button disabled", () => {
    const view = statusView(facts({ support: "denied" }));
    expect(view.notes).toEqual(["push.support.denied"]);
    expect(view.actionDisabled).toBe(true);
  });

  it("a browser subscription with no row for it offers the one-tap re-enable", () => {
    const view = statusView(facts({ browserSubscribed: true, devices: [device()] }));
    expect(view).toMatchObject({ action: "reenable", actionDisabled: false });
  });

  it("pwa.needsReenable offers the re-enable even with no subscription left", () => {
    expect(statusView(facts({ needsReenable: true })).action).toBe("reenable");
  });

  it("a re-enable is not offered while the server has push off", () => {
    const view = statusView(
      facts({ needsReenable: true, config: config({ status: "off", reason: "keys_unreadable" }) }),
    );
    expect(view.action).toBe("enable");
    expect(view.actionDisabled).toBe(true);
  });

  it("keysReset and lastFailure come from the contract fields", () => {
    const view = statusView(
      facts({
        config: config({
          keysReset: { at: 5, purged: 2 },
          lastFailure: { at: 6, reason: "rejected" },
        }),
      }),
    );
    expect(view.keysReset).toBe(true);
    expect(view.lastFailure).toBe("rejected");
    const none = statusView(facts());
    expect(none.keysReset).toBe(false);
    expect(none.lastFailure).toBeNull();
  });
});

describe("deviceRows", () => {
  it("keeps the order and marks the current device", () => {
    const rows = deviceRows([device({ id: "a" }), device({ id: "b", current: true })]);
    expect(rows.map((row) => [row.id, row.current])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("strips bidi and zero-width characters from what a device wrote", () => {
    const [row] = deviceRows([device({ label: "Pho\u202ene\u200b", host: "h\u2028ost" })]);
    expect(row?.label).toBe("Phone");
    expect(row?.host).toBe("host");
  });

  it("an emptied label falls back to a placeholder the view translates", () => {
    expect(deviceRows([device({ label: "\u202e" })])[0]?.label).toBe("");
  });
});

describe("mute presets", () => {
  const NOW = 1_800_000_000_000;
  it("computes muteUntil from the clock; Off is null", () => {
    expect(muteUntilOf("off", NOW)).toBeNull();
    expect(muteUntilOf("1h", NOW)).toBe(NOW + 3_600_000);
    expect(muteUntilOf("8h", NOW)).toBe(NOW + 8 * 3_600_000);
    expect(muteUntilOf("forever", NOW)).toBe(MUTE_FOREVER);
  });

  it("reads the stored value back as a preset", () => {
    expect(mutePreset(null, NOW)).toBe("off");
    expect(mutePreset(NOW - 1, NOW)).toBe("off");
    expect(mutePreset(NOW + 60_000, NOW)).toBe("1h");
    expect(mutePreset(NOW + 3 * 3_600_000, NOW)).toBe("8h");
    expect(mutePreset(MUTE_FOREVER, NOW)).toBe("forever");
    expect(mutePreset(NOW + 9 * 3_600_000, NOW)).toBe("custom");
  });

  it("the forever value survives a JSON round trip as the same integer", () => {
    expect(JSON.parse(JSON.stringify({ v: MUTE_FOREVER })).v).toBe(MUTE_FOREVER);
    expect(Number.isSafeInteger(MUTE_FOREVER)).toBe(true);
  });
});
