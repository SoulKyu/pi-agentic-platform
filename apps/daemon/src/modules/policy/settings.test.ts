import { DEFAULT_POLICY_SETTINGS, PapError, PolicySettings } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { policyV2Rpc } from "./rpc.ts";
import { createSessionPolicyService, RESTRICTIVE_SETTINGS } from "./session-service.ts";
import { createSessionPolicyStore } from "./session-store.ts";
import { createSettingsPolicyStore } from "./settings-store.ts";
import { sessionPolicyBed as bedOf, type SessionPolicyBedParts } from "./testing/bed.ts";

const make = ({ db, clock, logger, audit, sessionOwner }: SessionPolicyBedParts) => {
  const service = createSessionPolicyService({
    sessions: createSessionPolicyStore(db),
    settings: createSettingsPolicyStore(db),
    clock,
    logger,
    audit,
    sessionOwner,
  });
  return { service, rpc: policyV2Rpc(service) };
};
const sessionPolicyBed = () => bedOf(make);

let current: ReturnType<typeof sessionPolicyBed>;
beforeEach(() => {
  current = sessionPolicyBed();
});
afterEach(() => current.dispose());
const bed = () => current;
const caller = testCaller();
const stored = (db: ReturnType<typeof bed>["db"], owner = "u1") =>
  db.get<{ value: string; revision: number }>(
    "SELECT value, revision FROM policy_settings WHERE owner_id = $owner",
    { owner },
  );

describe("owner policy settings", () => {
  it("reads null at revision 0 when nothing is stored, and the defaults for the engine", () => {
    const { service } = bed();
    expect(service.getSettings(caller)).toEqual({ value: null, revision: 0 });
    expect(service.settings("u1")).toEqual(DEFAULT_POLICY_SETTINGS);
  });

  it("compares and sets: 0 creates, a stale base conflicts and leaves the value alone, the right base moves on", () => {
    const { service, db, settingsChanges } = bed();
    expect(service.setSettings(caller, { defaultMode: "supervised" }, 0)).toEqual({ revision: 1 });
    expect(() => service.setSettings(caller, { defaultMode: "read-only" }, 0)).toThrow(
      new PapError("conflict"),
    );
    expect(service.getSettings(caller)).toEqual({
      value: { ...DEFAULT_POLICY_SETTINGS, defaultMode: "supervised" },
      revision: 1,
    });
    expect(() => service.setSettings(caller, { defaultMode: "read-only" }, 7)).toThrow(
      new PapError("conflict"),
    );
    expect(service.setSettings(caller, { defaultMode: "read-only" }, 1)).toEqual({ revision: 2 });
    expect(service.settings("u1").defaultMode).toBe("read-only");
    expect(stored(db)?.revision).toBe(2);
    expect(settingsChanges).toEqual(["u1", "u1"]);
  });

  it("keeps each owner's document apart", () => {
    const { service } = bed();
    service.setSettings(caller, { defaultMode: "supervised" }, 0);
    expect(service.getSettings(testCaller({ userId: "u2" }))).toEqual({ value: null, revision: 0 });
    expect(service.settings("u2")).toEqual(DEFAULT_POLICY_SETTINGS);
    expect(service.setSettings(testCaller({ userId: "u2" }), {}, 0)).toEqual({ revision: 1 });
  });

  it.each([
    ["an unknown key", { defaultMode: "supervised", extra: true }],
    ["65 patterns", { denylist: Array.from({ length: 65 }, (_, i) => `p${i}`) }],
    ["an IP host", { allowHosts: ["127.0.0.1"] }],
    ["a bad mode", { defaultMode: "yolo" }],
    ["a non-object", "x"],
    ["null", null],
  ])("refuses %s as bad_request before any write", (_name, value) => {
    const { service, db, audits, settingsChanges } = bed();
    expect(() => service.setSettings(caller, value, 0)).toThrow(new PapError("bad_request"));
    expect(stored(db)).toBeUndefined();
    expect(audits).toEqual([]);
    expect(settingsChanges).toEqual([]);
  });

  it("accepts exactly 64 patterns and a host list, and audits the counts", () => {
    const { service, audits } = bed();
    const denylist = Array.from({ length: 64 }, (_, i) => `p${i}`);
    service.setSettings(
      caller,
      { denylist, allowHosts: ["a.example.com", "*.b.example.com"], builtinDenylist: false },
      0,
    );
    expect(audits).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        actorId: "test-device",
        kind: "policy",
        reason: "settings_changed",
        detail: { denylistCount: 64, hostCount: 2, defaultMode: "auto-accept-edits", builtinDenylist: false },
      },
    ]);
    service.setSettings(caller, {}, 1);
    expect(audits[1]?.detail).toEqual({
      denylistCount: 0,
      hostCount: null,
      defaultMode: "auto-accept-edits",
      builtinDenylist: true,
    });
  });

  it("does not audit a conflict", () => {
    const { service, audits } = bed();
    service.setSettings(caller, {}, 0);
    expect(() => service.setSettings(caller, {}, 0)).toThrow(new PapError("conflict"));
    expect(audits).toHaveLength(1);
  });

  it("reads a stored row that no longer parses as null for the client and as the restrictive settings for the engine, logging once", () => {
    const { service, db, lines } = bed();
    service.setSettings(caller, { defaultMode: "full-access" }, 0);
    db.run("UPDATE policy_settings SET value = '{\"defaultMode\":\"yolo\"}' WHERE owner_id = 'u1'");
    expect(service.getSettings(caller)).toEqual({ value: null, revision: 1 });
    expect(service.settings("u1")).toEqual(RESTRICTIVE_SETTINGS);
    expect(service.settings("u1")).toEqual(RESTRICTIVE_SETTINGS);
    expect(lines.filter((line) => line.msg === "policy_settings_unreadable")).toHaveLength(1);
    // The client saves over it from the revision it read.
    expect(service.setSettings(caller, {}, 1)).toEqual({ revision: 2 });
    expect(service.settings("u1")).toEqual(DEFAULT_POLICY_SETTINGS);
  });

  it("pins the restrictive settings: supervised, preset on, an empty host list", () => {
    expect(RESTRICTIVE_SETTINGS).toEqual({
      defaultMode: "supervised",
      builtinDenylist: true,
      denylist: [],
      allowHosts: [],
      readOnlyCommands: false,
      localTools: [],
    });
  });

  it("stores the owner's local tools, hands them to the engine, and reads an older document without them (A2)", () => {
    const { service, db } = bed();
    const localTools = [{ tool: "todo", source: "/x/ext/todo.ts" }];
    service.setSettings(caller, { localTools }, 0);
    expect(service.settings("u1").localTools).toEqual(localTools);
    expect(service.getSettings(caller).value).toMatchObject({ localTools });
    db.run("UPDATE policy_settings SET value = '{\"defaultMode\":\"supervised\"}' WHERE owner_id = 'u1'");
    expect(service.settings("u1").localTools).toEqual([]);
  });

  it("reads a stored document without the read-only switch as on", () => {
    const { service, db } = bed();
    service.setSettings(caller, {}, 0);
    db.run("UPDATE policy_settings SET value = '{\"defaultMode\":\"supervised\"}' WHERE owner_id = 'u1'");
    expect(service.settings("u1")).toEqual({ ...DEFAULT_POLICY_SETTINGS, defaultMode: "supervised" });
    expect(service.settings("u1").readOnlyCommands).toBe(true);
  });

  it("uses the restrictive default mode for a session that follows the default", () => {
    const { service, db } = bed();
    service.setSettings(caller, { defaultMode: "full-access" }, 0);
    db.run("UPDATE policy_settings SET value = '[]' WHERE owner_id = 'u1'");
    expect(service.sessionPolicy("u1", "s1")).toMatchObject({ mode: "supervised", explicit: false });
  });

  it("bounds the once-per-owner log memory: the log repeats after 1024 distinct owners", () => {
    const { service, db, lines } = bed();
    for (let i = 0; i <= 1024; i++) {
      db.run("INSERT INTO policy_settings (owner_id, value, revision, updated_at) VALUES ($id, '[]', 1, 1)", {
        id: `o${i}`,
      });
      service.settings(`o${i}`);
    }
    const count = () => lines.filter((line) => line.msg === "policy_settings_unreadable").length;
    expect(count()).toBe(1025);
    service.settings("o0");
    expect(count()).toBe(1026);
    service.settings("o0");
    expect(count()).toBe(1026);
  });

  it("refuses a stored document over 64 KiB at the database", () => {
    const { db } = bed();
    const big = JSON.stringify({ pad: "x".repeat(65_536) });
    expect(() =>
      db.run(
        "INSERT INTO policy_settings (owner_id, value, revision, updated_at) VALUES ('u1', $big, 1, 1)",
        { big },
      ),
    ).toThrow();
  });

  it("refuses, as bad_request, a valid document that would not fit the 64 KiB column", () => {
    const { service, db } = bed();
    // 256 distinct hosts of 253 characters each: valid one by one, 65 540 bytes together.
    const letters = (n: number) =>
      [n % 26, Math.floor(n / 26) % 26, Math.floor(n / 676)].map((d) => String.fromCharCode(97 + d)).join("");
    const allowHosts = Array.from({ length: 256 }, (_, i) =>
      [`${letters(i)}${"a".repeat(60)}`, "b".repeat(63), "c".repeat(63), "d".repeat(61)].join("."),
    );
    expect(PolicySettings.safeParse({ allowHosts }).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ...DEFAULT_POLICY_SETTINGS, allowHosts }))).toBeGreaterThan(
      65_536,
    );
    expect(() => service.setSettings(caller, { allowHosts }, 0)).toThrow(new PapError("bad_request"));
    expect(stored(db)).toBeUndefined();
  });
});
