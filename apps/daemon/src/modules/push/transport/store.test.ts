import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openTransportBed, subInput, type TransportBed } from "../testing/transport-bed.ts";

let bed: TransportBed;
afterEach(() => bed.close());
const open = (options?: Parameters<typeof openTransportBed>[0]) => (bed = openTransportBed(options));
const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : error;
  }
  return "no error";
};

describe("subscription store", () => {
  it("cap-refuses-11th-never-evicts", () => {
    const { store } = open();
    const ids = Array.from({ length: 10 }, (_, n) => store.add("u1", "c1", subInput(n)).id);
    const before = store.targets("u1").map((t) => t.id);
    expect(code(() => store.add("u1", "c1", subInput(10)))).toBe("capacity");
    expect(store.countFor("u1")).toBe(10);
    expect(store.targets("u1").map((t) => t.id)).toEqual(before);
    expect(before.sort()).toEqual([...ids].sort());
  });

  it("same-endpoint-refreshes-at-cap", () => {
    const { store } = open();
    const inputs = Array.from({ length: 10 }, (_, n) => subInput(n));
    const ids = inputs.map((input) => store.add("u1", "c1", input).id);
    const again = subInput(3, { label: "Renamed", locale: "fr" });
    expect(store.add("u1", "c1", again).id).toBe(ids[3]);
    expect(store.countFor("u1")).toBe(10);
    expect(store.list("u1", "c1").find((item) => item.id === ids[3])?.label).toBe("Renamed");
    expect(store.targets("u1").find((t) => t.id === ids[3])).toMatchObject({
      locale: "fr",
      p256dh: again.keys.p256dh,
      auth: again.keys.auth,
    });
  });

  it("relogin-rebinds-credential", () => {
    const { store } = open();
    const input = subInput(1);
    const { id } = store.add("u1", "old-cred", input);
    expect(store.targets("u1", "new-cred")).toEqual([]);
    expect(store.add("u1", "new-cred", input).id).toBe(id);
    expect(store.targets("u1", "old-cred")).toEqual([]);
    expect(store.targets("u1", "new-cred").map((t) => t.id)).toEqual([id]);
    expect(store.targets("u1", "new-cred")[0]?.credentialId).toBe("new-cred");
  });

  it("other-owner-conflict", () => {
    const { store } = open();
    const input = subInput(1);
    store.add("u1", "c1", input);
    expect(code(() => store.add("u2", "c9", input))).toBe("conflict");
    expect(store.countFor("u2")).toBe(0);
    expect(store.countFor("u1")).toBe(1);
  });

  it("list-has-no-endpoint-or-keys", () => {
    const { store } = open();
    const input = subInput(1);
    store.add("u1", "c1", input);
    const json = JSON.stringify(store.list("u1", "c1"));
    expect(json).not.toContain("secretpath");
    expect(json).not.toContain("https://");
    expect(json).not.toContain(input.keys.p256dh);
    expect(json).not.toContain(input.keys.auth);
    expect(json).not.toMatch(/p256dh|auth|endpoint/);
    expect(store.list("u1", "c1")[0]).toMatchObject({ host: "web.push.apple.com", lastOkAt: null });
  });

  it("list-current-flag", () => {
    const { store } = open();
    store.add("u1", "mine", subInput(1));
    store.add("u1", "theirs", subInput(2));
    expect(store.list("u1", "mine").map((item) => [item.label, item.current])).toEqual([
      ["Phone 1", true],
      ["Phone 2", false],
    ]);
    expect(store.list("u2", "mine")).toEqual([]);
  });

  it("revoke-other-owners-row-not_found", () => {
    const { store } = open();
    const { id } = store.add("u1", "c1", subInput(1));
    expect(store.revoke("u2", id)).toBe(false);
    expect(store.revoke("u1", "nope")).toBe(false);
    expect(store.countFor("u1")).toBe(1);
    expect(store.revoke("u1", id)).toBe(true);
    expect(store.countFor("u1")).toBe(0);
  });

  it("bad-endpoint-reasons-not-echoed", () => {
    const { store, logs } = open();
    const secret = "https://evil.example/very-secret-token-path";
    const error = (() => {
      try {
        store.add("u1", "c1", subInput(1, { endpoint: secret }));
      } catch (e) {
        return e as PapError;
      }
      return null;
    })();
    expect(error?.code).toBe("bad_request");
    expect(error?.message).not.toContain("evil");
    expect(JSON.stringify(logs)).not.toContain("evil.example");
    expect(JSON.stringify(logs)).not.toContain("very-secret");
    expect(logs.find((line) => line.msg === "push_subscribe_refused")).toMatchObject({
      reason: "host_not_allowed",
    });
    expect(
      code(() =>
        store.add("u1", "c1", subInput(1, { keys: { p256dh: "A".repeat(87), auth: "b".repeat(22) } })),
      ),
    ).toBe("bad_request");
    expect(
      code(() =>
        store.add("u1", "c1", subInput(1, { keys: { ...subInput(1).keys, auth: "====".repeat(5) + "==" } })),
      ),
    ).toBe("bad_request");
    expect(store.countFor("u1")).toBe(0);
  });

  it("stores the canonical href and a sha-256 hash of it, never the raw text", () => {
    const { store, db } = open();
    store.add("u1", "c1", subInput(1, { endpoint: "https://WEB.PUSH.APPLE.COM:443/send/Abc-defghijkl" }));
    const row = db.get<{ endpoint: string; endpoint_hash: string }>(
      "SELECT endpoint, endpoint_hash FROM push_subs",
    );
    expect(row?.endpoint).toBe("https://web.push.apple.com/send/Abc-defghijkl");
    expect(row?.endpoint_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.targets("u1")[0]?.endpoint).toBe(row?.endpoint);
    // the same device spelled another way is the same row
    store.add("u1", "c1", subInput(1, { endpoint: "https://web.push.apple.com/send/Abc-defghijkl" }));
    expect(store.countFor("u1")).toBe(1);
  });

  it("labels lose controls, format and separator characters and are clipped", () => {
    const { store } = open();
    store.add(
      "u1",
      "c1",
      subInput(1, { label: "  My\u0000 \u202Ephone\u200B\u2028\u0085 " + "x".repeat(200) }),
    );
    const label = store.list("u1", "c1")[0]?.label ?? "";
    expect(label).toBe(("My phone " + "x".repeat(200)).slice(0, 80));
    expect([...label].length).toBeLessThanOrEqual(80);
    store.add("u1", "c1", subInput(2, { label: "\u200B\u202E" }));
    expect(store.list("u1", "c1")[1]?.label).toBe("Device");
  });

  it("refuses to store anything while push has no key", () => {
    const { store } = open({ keyId: null });
    expect(code(() => store.add("u1", "c1", subInput(1)))).toBe("push_unavailable");
    expect(store.countFor("u1")).toBe(0);
  });

  it("purge-foreign-keys", () => {
    const { store, db } = open({ keyId: "currentcurrent00" });
    store.add("u1", "c1", subInput(1));
    store.add("u1", "c1", subInput(2));
    db.run("UPDATE push_subs SET key_id = 'oldoldoldoldold0' WHERE label = 'Phone 1'");
    expect(store.purgeForeignKeys("currentcurrent00")).toBe(1);
    expect(store.list("u1", "c1").map((item) => item.label)).toEqual(["Phone 2"]);
    expect(store.purgeForeignKeys("currentcurrent00")).toBe(0);
  });

  it("markOk stamps the row, drop deletes it and logs the hash only", () => {
    const { store, logs } = open();
    const input = subInput(1);
    const { id } = store.add("u1", "c1", input);
    store.markOk(id, 1234);
    expect(store.list("u1", "c1")[0]?.lastOkAt).toBe(1234);
    store.drop(id, "gone");
    expect(store.countFor("u1")).toBe(0);
    const line = logs.find((entry) => entry.msg === "push_subscription_dropped");
    expect(line).toMatchObject({ why: "gone" });
    expect(String(line?.endpoint)).toMatch(/^h:[0-9a-f]{12}$/);
    const text = JSON.stringify(logs);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("secretpath");
    expect(text).not.toContain(input.keys.auth);
    store.drop("missing", "gone"); // nothing to drop: no throw, no line
    expect(logs.filter((entry) => entry.msg === "push_subscription_dropped")).toHaveLength(1);
  });

  it("an add clears the keys reset notice, a failed one does not", () => {
    const { store, db } = open();
    db.run("INSERT INTO push_meta (key, value) VALUES ('keys_reset', '{\"at\":1,\"purged\":2}')");
    code(() => store.add("u1", "c1", subInput(1, { endpoint: "https://evil.example/aaaaaaaaaaaa" })));
    expect(db.get("SELECT 1 FROM push_meta WHERE key = 'keys_reset'")).toBeDefined();
    store.add("u1", "c1", subInput(2));
    expect(db.get("SELECT 1 FROM push_meta WHERE key = 'keys_reset'")).toBeUndefined();
  });

  it("accepts loopback endpoints only with the test switch", () => {
    const local = { endpoint: "http://127.0.0.1:4555/push/aaaaaaaaaa" };
    open();
    expect(code(() => bed.store.add("u1", "c1", subInput(1, local)))).toBe("bad_request");
    bed.close();
    open({ loopback: true });
    expect(bed.store.add("u1", "c1", subInput(1, local)).id).toBeTruthy();
  });

  it("revoke-sticks (W6-R15): a refresh of the revoked endpoint is push_revoked, a new endpoint is accepted, the mark is bounded", () => {
    const { store } = open();
    const input = subInput(1);
    const { id } = store.add("u1", "c1", input);
    expect(store.revoke("u1", id)).toBe(true);
    expect(code(() => store.add("u1", "c1", input))).toBe("push_revoked");
    expect(store.countFor("u1")).toBe(0);
    // another owner is not affected by u1's mark, and a new endpoint of u1's own device is accepted
    expect(code(() => store.add("u2", "c9", input))).toBe("no error");
    expect(code(() => store.add("u1", "c1", subInput(2)))).toBe("no error");
    // 60 revocations keep only the newest 50 marks: the oldest endpoint can enrol again
    const first = subInput(100);
    for (let n = 100; n < 160; n++) {
      const added = n === 100 ? first : subInput(n);
      store.revoke("u3", store.add("u3", "c3", added).id);
    }
    expect(code(() => store.add("u3", "c3", first))).toBe("no error");
    expect(code(() => store.add("u3", "c3", subInput(159)))).toBe("push_revoked");
  });
});
