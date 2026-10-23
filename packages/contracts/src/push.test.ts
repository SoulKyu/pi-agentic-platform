import { describe, expect, it } from "vitest";
import {
  NotificationsSettings,
  PUSH_CLASSES,
  PUSH_LIMITS,
  PushSubscriptionInput,
  PushTarget,
  PushWire,
  SettingWrite,
  WIRE_CLASSES,
} from "./index.ts";

const P256DH = "A".repeat(87);
const AUTH = "b".repeat(22);
const ID = "abcdefghijklmnopqrstuv";
const subscription = {
  endpoint: "https://push.example.net/send/abcdefgh",
  keys: { p256dh: P256DH, auth: AUTH },
  locale: "fr",
  label: "Phone",
} as const;

describe("PushSubscriptionInput", () => {
  it("accepts a well-formed subscription", () => {
    expect(PushSubscriptionInput.parse(subscription)).toEqual(subscription);
  });

  it.each([
    ["a p256dh of 86 characters", { keys: { p256dh: "A".repeat(86), auth: AUTH } }],
    ["a p256dh of 88 characters", { keys: { p256dh: "A".repeat(88), auth: AUTH } }],
    ["an auth of 21 characters", { keys: { p256dh: P256DH, auth: "b".repeat(21) } }],
    ["an auth of 23 characters", { keys: { p256dh: P256DH, auth: "b".repeat(23) } }],
    ["an extra key", { keys: { p256dh: P256DH, auth: AUTH, extra: "x" } }],
    ["an endpoint of 2049 characters", { endpoint: `https://${"a".repeat(2041)}` }],
    ["an empty label", { label: "   " }],
    ["an unknown locale", { locale: "de" }],
    ["an extra top-level field", { token: "x" }],
  ])("refuses %s", (_name, patch) => {
    expect(PushSubscriptionInput.safeParse({ ...subscription, ...patch }).success).toBe(false);
  });

  it("accepts an endpoint of exactly 2048 characters", () => {
    const endpoint = `https://${"a".repeat(2040)}`;
    expect(endpoint).toHaveLength(PUSH_LIMITS.endpointMax);
    expect(PushSubscriptionInput.safeParse({ ...subscription, endpoint }).success).toBe(true);
  });
});

describe("NotificationsSettings (M12R18, M12-RT-14)", () => {
  const defaults = {
    classes: {
      approval: true,
      failed: true,
      budget: true,
      notify: true,
      done: false,
      reply: false,
    },
    muteUntil: null,
    titles: "generic",
  };

  it("writes every default out for an empty document (the zod 4 default({}) trap)", () => {
    expect(NotificationsSettings.parse({})).toEqual(defaults);
    expect(Object.keys(NotificationsSettings.parse({}).classes).sort()).toEqual([...PUSH_CLASSES].sort());
  });

  it("keeps the other defaults when one class is set", () => {
    expect(NotificationsSettings.parse({ classes: { done: true } })).toEqual({
      ...defaults,
      classes: { ...defaults.classes, done: true },
    });
  });

  it("parses stored prefs with the old review class and drops it", () => {
    const parsed = NotificationsSettings.parse({ classes: { review: true, done: true } });
    expect(parsed.classes).not.toHaveProperty("review");
    expect(parsed.classes.done).toBe(true);
  });

  it("refuses an unknown class, a negative mute and an unknown titles mode", () => {
    expect(NotificationsSettings.safeParse({ classes: { loud: true } }).success).toBe(false);
    expect(NotificationsSettings.safeParse({ muteUntil: -1 }).success).toBe(false);
    expect(NotificationsSettings.safeParse({ titles: "free" }).success).toBe(false);
  });

  it("is a key of settings.set", () => {
    expect(SettingWrite.safeParse({ key: "notifications", value: {}, baseRevision: 0 }).success).toBe(true);
  });
});

describe("PushWire", () => {
  const wire = { v: 1, id: ID, cls: "approval", title: "pap", body: "Une demande vous attend.", ts: 1 };

  it("accepts a wire payload, digest and test classes included", () => {
    expect(PushWire.parse(wire)).toEqual(wire);
    expect(WIRE_CLASSES).toEqual([...PUSH_CLASSES, "digest", "test"]);
    expect(PushWire.safeParse({ ...wire, cls: "digest" }).success).toBe(true);
  });

  it.each([
    ["v 2", { v: 2 }],
    ["an id of 21 characters", { id: ID.slice(0, 21) }],
    ["a UUID id", { id: "123e4567-e89b-12d3-a456-426614174000" }],
    ["an unknown class", { cls: "loud" }],
    ["an extra field", { url: "https://example.net" }],
    ["a title of 81 characters", { title: "t".repeat(81) }],
    ["a body of 201 characters", { body: "b".repeat(201) }],
  ])("refuses %s", (_name, patch) => {
    expect(PushWire.safeParse({ ...wire, ...patch }).success).toBe(false);
  });
});

describe("PushTarget", () => {
  it("takes a kind and a nullable id, nothing else", () => {
    expect(PushTarget.parse({ kind: "settings", id: null })).toEqual({ kind: "settings", id: null });
    expect(PushTarget.safeParse({ kind: "url", id: "x" }).success).toBe(false);
    expect(PushTarget.safeParse({ kind: "inbox", id: "x", url: "/" }).success).toBe(false);
  });
});

describe("PUSH_LIMITS", () => {
  it("states the caps of M12R9 and M12R11", () => {
    expect(PUSH_LIMITS).toEqual({
      subscriptionsPerOwner: 10,
      endpointMax: 2048,
      labelMax: 80,
      presenceTtlMs: 45_000,
      presenceEntries: 64,
    });
  });
});
