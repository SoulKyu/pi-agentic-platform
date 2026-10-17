import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { PUSH_MIGRATIONS } from "../index.ts";
import { subInput } from "../testing/transport-bed.ts";
import { bootTransport } from "./boot.ts";
import { hostRules } from "./endpoint.ts";
import { createPushMeta } from "./meta.ts";
import { loadVapid } from "./vapid.ts";

let bed: OutboxBed;
let dir: string;
afterEach(() => {
  bed.close();
  rmSync(dir, { recursive: true, force: true });
});

function boot(readOnly = false) {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
  dir = mkdtempSync(join(tmpdir(), "pap-push-boot-"));
  const run = () => {
    const vapid = readOnly ? null : loadVapid(dir, bed.logger);
    const subscriptions = bootTransport({
      vapid,
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      hosts: hostRules([]),
      loopbackForTests: false,
    });
    return { vapid, subscriptions };
  };
  return { run, meta: createPushMeta(bed.db) };
}
const lines = (msg: string) => bed.logs.filter((line) => line.msg === msg);

describe("bootTransport", () => {
  it("a first boot mints the key, purges nothing and reports no reset", () => {
    const { run, meta } = boot();
    const { vapid, subscriptions } = run();
    expect(vapid?.kind).toBe("ready");
    expect(subscriptions.countFor("u1")).toBe(0);
    expect(meta.keysReset()).toBeNull();
    expect(lines("push_keys_reset")).toEqual([]);
  });

  it("a read-only database mints nothing and purges nothing", () => {
    const { run, meta } = boot(true);
    const { vapid, subscriptions } = run();
    expect(vapid).toBeNull();
    expect(existsSync(join(dir, "push"))).toBe(false);
    expect(meta.keysReset()).toBeNull();
    expect(() => subscriptions.add("u1", "c1", subInput(1))).toThrow();
  });

  it("a restart keeps the rows: the key is the same", () => {
    const { run } = boot();
    run().subscriptions.add("u1", "c1", subInput(1));
    const again = run();
    expect(again.subscriptions.countFor("u1")).toBe(1);
    expect(lines("push_keys_reset")).toEqual([]);
  });

  it("boot.reports-reset: a missing file on a populated table purges the rows and reports the count", () => {
    const { run, meta } = boot();
    const first = run();
    first.subscriptions.add("u1", "c1", subInput(1));
    first.subscriptions.add("u1", "c2", subInput(2));
    rmSync(join(dir, "push", "vapid.json"));
    bed.logs.length = 0;
    const second = run();
    expect(second.vapid?.kind === "ready" && second.vapid.minted).toBe(true);
    expect(second.subscriptions.countFor("u1")).toBe(0);
    expect(meta.keysReset()).toEqual({ at: bed.clock.now(), purged: 2 });
    const reset = lines("push_keys_reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ purged: 2 });
    expect(JSON.stringify(bed.logs)).not.toContain("https://");
    // the next subscribe clears the notice
    second.subscriptions.add("u1", "c1", subInput(3));
    expect(meta.keysReset()).toBeNull();
  });

  it("a damaged file keeps push off and purges nothing", () => {
    const { run, meta } = boot();
    const first = run();
    first.subscriptions.add("u1", "c1", subInput(1));
    writeFileSync(join(dir, "push", "vapid.json"), "{ not json");
    chmodSync(join(dir, "push", "vapid.json"), 0o600);
    bed.logs.length = 0;
    const second = run();
    expect(second.vapid).toEqual({ kind: "off", reason: "keys_unreadable" });
    expect(second.subscriptions.countFor("u1")).toBe(1);
    expect(meta.keysReset()).toBeNull();
    expect(lines("push_keys_reset")).toEqual([]);
    expect(() => second.subscriptions.add("u1", "c1", subInput(2))).toThrow();
  });

  it("purge-foreign-keys on boot also handles rows left by an earlier key (a swapped file)", () => {
    const { run } = boot();
    const first = run();
    first.subscriptions.add("u1", "c1", subInput(1));
    bed.db.run("UPDATE push_subs SET key_id = 'ffffffffffffffff'");
    bed.logs.length = 0;
    expect(run().subscriptions.countFor("u1")).toBe(0);
    expect(lines("push_keys_reset")[0]).toMatchObject({ purged: 1 });
  });
});
