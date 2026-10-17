import { afterEach, describe, expect, it } from "vitest";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";

let t: SendBed;
afterEach(() => t.close());
const ref = { ownerId: OWNER, refKind: "session", refId: "s1" } as const;
const lastFailure = () =>
  t.bed.db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = $key", {
    key: `last_failure:${OWNER}`,
  })?.value;

describe("push off with old rows (final review, minor 2)", () => {
  it("an event settles cancelled push_off without deliveries, a send or a recorded failure", async () => {
    t = openSendBed(["a"]);
    t.transport.setStatus(false);
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "push_off" });
    expect(t.deliveries()).toEqual([]);
    expect(t.transport.sent).toEqual([]);
    expect(lastFailure()).toBeUndefined();
  });
});

describe("the last failure clears on the next success (final review, minor 1)", () => {
  it("a sent event removes the owner's last_failure; another owner's stays", async () => {
    t = openSendBed(["a"]);
    t.bed.db.run('INSERT INTO push_meta (key, value) VALUES ($k, \'{"at":1,"reason":"rejected"}\')', {
      k: `last_failure:${OWNER}`,
    });
    t.bed.db.run(
      'INSERT INTO push_meta (key, value) VALUES (\'last_failure:other\', \'{"at":1,"reason":"rejected"}\')',
    );
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "sent" });
    expect(lastFailure()).toBeUndefined();
    expect(t.bed.db.get("SELECT 1 FROM push_meta WHERE key = 'last_failure:other'")).toBeDefined();
  });
});
