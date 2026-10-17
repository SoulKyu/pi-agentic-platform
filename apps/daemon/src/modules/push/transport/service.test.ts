import { PapError, type Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../../testing/caller.ts";
import { createPushMeta } from "./meta.ts";
import { createTransportService } from "./service.ts";
import { fakeAudit, openTransportBed, subInput, type TransportBed } from "../testing/transport-bed.ts";

let bed: TransportBed;
afterEach(() => bed.close());

const browser = (over: Partial<Caller> = {}) => testCaller(over);
const token = () => testCaller({ kind: "token", credentialId: "tok" });

function open(options: { readOnly?: boolean; status?: "on" | "off"; tls?: boolean; origin?: string } = {}) {
  bed = openTransportBed();
  const audit = fakeAudit();
  const meta = createPushMeta(bed.db);
  const service = createTransportService({
    store: bed.store,
    meta,
    transport: {
      status: () =>
        options.status === "off"
          ? { on: false, reason: "keys_unreadable", publicKey: null }
          : { on: true, reason: null, publicKey: "PUBKEY" },
    },
    readiness: {
      publicOrigin: options.origin ?? "https://pap.example.net",
      tls: options.tls ?? false,
      insecureHttp: false,
    },
    clock: bed.clock,
    audit,
    logger: bed.logger,
    readOnly: options.readOnly === true,
  });
  return { service, audit, meta };
}
const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : error;
  }
  return "no error";
};

describe("transport service", () => {
  it("a token is refused first, on every method, before any read or write", () => {
    const { service, audit } = open();
    const t = token();
    expect(code(() => service.config(t))).toBe("forbidden");
    expect(code(() => service.subscribe(t, subInput(1)))).toBe("forbidden");
    expect(code(() => service.list(t))).toBe("forbidden");
    expect(code(() => service.revoke(t, "x"))).toBe("forbidden");
    expect(bed.store.countFor("u1")).toBe(0);
    expect(audit.rows).toEqual([]);
  });

  it("subscribe stores the row for the caller's owner and credential and answers the id", () => {
    const { service } = open();
    const { id } = service.subscribe(browser({ credentialId: "dev-1" }), subInput(1));
    expect(bed.store.targets("u1", "dev-1").map((t) => t.id)).toEqual([id]);
    expect(service.list(browser({ credentialId: "dev-1" })).items.map((i) => [i.id, i.current])).toEqual([
      [id, true],
    ]);
    expect(service.list(browser({ credentialId: "dev-2" })).items[0]?.current).toBe(false);
  });

  it("rate-limit-subscribe: the 2nd call within 6 s is refused, the 3rd after 6 s passes", async () => {
    const { service } = open();
    const caller = browser();
    service.subscribe(caller, subInput(1));
    await bed.clock.advance(5_999);
    expect(code(() => service.subscribe(caller, subInput(2)))).toBe("rate_limited");
    await bed.clock.advance(1);
    expect(service.subscribe(caller, subInput(2)).id).toBeTruthy();
    expect(bed.store.countFor("u1")).toBe(2);
    // another owner has its own window
    expect(service.subscribe(browser({ userId: "u2" }), subInput(3)).id).toBeTruthy();
  });

  it("a refused call still spends the owner's window (a flood of bad endpoints is a flood)", () => {
    const { service } = open();
    expect(
      code(() =>
        service.subscribe(browser(), subInput(1, { endpoint: "https://evil.example/aaaaaaaaaaaaaa" })),
      ),
    ).toBe("bad_request");
    expect(code(() => service.subscribe(browser(), subInput(2)))).toBe("rate_limited");
  });

  it("audit-has-hash-not-endpoint", () => {
    const { service, audit } = open();
    const input = subInput(1);
    const { id } = service.subscribe(browser({ credentialId: "dev-1" }), input);
    service.revoke(browser(), id);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({
      ownerId: "u1",
      actor: "user",
      kind: "auth",
      reason: "push.subscribe",
    });
    expect(audit.rows[1]).toMatchObject({
      ownerId: "u1",
      actor: "user",
      kind: "auth",
      reason: "push.revoke",
    });
    for (const row of audit.rows) {
      expect(row.detail).toMatchObject({ host: "web.push.apple.com" });
      expect(String((row.detail as Record<string, unknown>).endpoint)).toMatch(/^h:[0-9a-f]{12}$/);
    }
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("secretpath");
    expect(text).not.toContain(input.keys.p256dh);
    expect(text).not.toContain(input.keys.auth);
  });

  it("revoke answers not_found for a row of another owner or one that never existed, and audits nothing", () => {
    const { service, audit } = open();
    const { id } = service.subscribe(browser({ userId: "u2" }), subInput(1));
    expect(code(() => service.revoke(browser(), id))).toBe("not_found");
    expect(code(() => service.revoke(browser(), "nope"))).toBe("not_found");
    expect(audit.rows.map((r) => r.reason)).toEqual(["push.subscribe"]);
    expect(bed.store.countFor("u2")).toBe(1);
  });

  it("read-only-subscribe: subscribe answers read_only and config says so", () => {
    const { service } = open({ readOnly: true });
    expect(code(() => service.subscribe(browser(), subInput(1)))).toBe("read_only");
    expect(service.config(browser())).toMatchObject({ status: "off", reason: "read_only" });
    expect(bed.store.countFor("u1")).toBe(0);
  });

  it("config reports key, status, readiness, count, max, keysReset and the owner's last failure", () => {
    const { service, meta } = open();
    expect(service.config(browser())).toEqual({
      publicKey: "PUBKEY",
      status: "on",
      reason: null,
      readiness: { status: "ready" },
      subscribed: 0,
      max: 10,
      lastFailure: null,
      keysReset: null,
    });
    service.subscribe(browser(), subInput(1));
    meta.setKeysReset({ at: 5, purged: 3 });
    bed.db.run(
      'INSERT INTO push_meta (key, value) VALUES (\'last_failure:u1\', \'{"at":9,"reason":"rejected"}\')',
    );
    bed.db.run(
      'INSERT INTO push_meta (key, value) VALUES (\'last_failure:u2\', \'{"at":10,"reason":"refused"}\')',
    );
    expect(service.config(browser())).toMatchObject({
      subscribed: 1,
      keysReset: { at: 5, purged: 3 },
      lastFailure: { at: 9, reason: "rejected" },
    });
    expect(service.config(browser({ userId: "u2" }))).toMatchObject({
      lastFailure: { at: 10, reason: "refused" },
      subscribed: 0,
    });
  });

  it("config shows an off transport with its reason and a damaged last_failure row as null", () => {
    const { service } = open({ status: "off" });
    bed.db.run("INSERT INTO push_meta (key, value) VALUES ('last_failure:u1', 'not json')");
    expect(service.config(browser())).toMatchObject({
      status: "off",
      reason: "keys_unreadable",
      publicKey: null,
      lastFailure: null,
    });
    bed.db.run('UPDATE push_meta SET value = \'{"at":1,"reason":"a response body"}\'');
    expect(service.config(browser()).lastFailure).toBeNull();
  });

  it("config carries the readiness hint of a plain http origin", () => {
    const { service } = open({ origin: "http://192.0.2.7:7777" });
    expect(service.config(browser()).readiness.status).toBe("insecure_http");
    expect(service.config(browser()).readiness.hint).toBeTruthy();
  });

  it("a subscribe while push has no key answers push_unavailable", () => {
    bed = openTransportBed({ keyId: null });
    const service = createTransportService({
      store: bed.store,
      meta: createPushMeta(bed.db),
      transport: { status: () => ({ on: false, reason: "keys_unreadable", publicKey: null }) },
      readiness: { publicOrigin: "https://pap.example.net", tls: false, insecureHttp: false },
      clock: bed.clock,
      audit: fakeAudit(),
      logger: bed.logger,
      readOnly: false,
    });
    expect(code(() => service.subscribe(browser(), subInput(1)))).toBe("push_unavailable");
  });
});
