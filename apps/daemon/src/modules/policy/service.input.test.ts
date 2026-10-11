import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed, KEY, keyOf } from "./testing/bed.ts";

let bed: ReturnType<typeof makeBed>;
const makeBed = () => {
  const base = createPolicyBed();
  const store = createPolicyStore(base.db);
  const service = createPolicyService({ store, clock: base.clock, logger: base.logger, newId: base.newId });
  return { ...base, store, service };
};
beforeEach(() => {
  bed = makeBed();
});
afterEach(() => bed.dispose());

const rule = { ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" };
const bad = new PapError("bad_request");

describe("addAlways input", () => {
  it.each([
    ["an empty tool", { tool: "" }],
    ["a tool over 256 characters", { tool: "t".repeat(257) }],
    ["a tool with a NUL", { tool: "ba\u0000sh" }],
    ["a tool with a control character", { tool: "ba\u001bsh" }],
    ["an empty scope", { scope: "" }],
    ["a scope over 4096 characters", { scope: "/".repeat(4097) }],
    ["a scope with a NUL", { scope: "/w\u0000/x" }],
    ["a scope with a newline", { scope: "/w\n/x" }],
    ["a key that is not 64 hex characters", { key: "short" }],
    ["a 64-character key with a NUL after it", { key: `${KEY}\u0000x` }],
  ])("throws and stores nothing for %s", (_name, over) => {
    expect(() => bed.service.addAlways({ ...rule, ...over })).toThrow(bad);
    expect(bed.service.list("u1")).toEqual([]);
  });

  it("accepts the bounds themselves", () => {
    expect(bed.service.addAlways({ ...rule, tool: "t".repeat(256), scope: "/".repeat(4096) })).toBe("added");
    expect(bed.service.listPage("u1").rules).toHaveLength(1);
  });

  it("never refuses a rule for its label: controls become U+FFFD, tab and newline stay, the clip keeps pairs whole", () => {
    const { service } = bed;
    service.addAlways({ ...rule, key: keyOf(1), label: "a\u0000b\u001bc\td\ne\u007f" });
    service.addAlways({ ...rule, key: keyOf(2), label: `${"x".repeat(4095)}\u{1F600}` });
    service.addAlways({ ...rule, key: keyOf(3), label: "y".repeat(5000) });
    const labels = service.list("u1").map((r) => r.label);
    expect(labels[2]).toBe("a�b�c\td\ne\u007f");
    expect(labels[1]).toBe("x".repeat(4095));
    expect(labels[0]).toBe("y".repeat(4096));
  });

  it("skips a stored row that fails the result schema, says so in truncated, and logs it once", () => {
    const { service, db, lines } = bed;
    service.addAlways({ ...rule, key: keyOf(1) });
    for (const id of ["bad1", "bad2"]) {
      db.run(
        "INSERT INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at) VALUES ($id, 'u1', 'project', '/w', '', $key, 'l', 1)",
        { id, key: `${id}`.padEnd(64, "0") },
      );
    }
    const page = service.listPage("u1");
    expect(page.rules.map((r) => r.id)).toEqual(["r1"]);
    expect(page.truncated).toBe(true);
    const logged = lines.filter((l) => l.msg === "policy_rule_invalid");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ skipped: 2 });
    service.revoke("u1", "bad1");
  });
});

describe("listing without a folder", () => {
  it("says truncated when the owner holds more than 1000 rules across projects, newest kept", async () => {
    const { service, clock } = bed;
    for (let i = 1; i <= 1000; i++) service.addAlways({ ...rule, scope: "/a", key: keyOf(i) });
    await clock.advance(5);
    for (let i = 1; i <= 3; i++) service.addAlways({ ...rule, scope: "/b", key: keyOf(i) });
    const page = service.listPage("u1");
    expect(page.rules).toHaveLength(1000);
    expect(page.truncated).toBe(true);
    expect(page.rules.slice(0, 3).map((r) => r.scope)).toEqual(["/b", "/b", "/b"]);
    expect(service.listPage("u1", "/nowhere-at-all-xyz").truncated).toBe(false);
  });

  it("is not truncated at exactly 1000", () => {
    const { service } = bed;
    for (let i = 1; i <= 1000; i++) service.addAlways({ ...rule, key: keyOf(i) });
    const page = service.listPage("u1");
    expect([page.rules.length, page.truncated]).toEqual([1000, false]);
  });

  it("orders both listings by creation time, then id, newest first", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-policy-order-")));
    try {
      const { service } = bed;
      // One millisecond for all three: only the id breaks the tie.
      for (let i = 1; i <= 3; i++) service.addAlways({ ...rule, scope: dir, key: keyOf(i) });
      expect(service.list("u1").map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
      expect(service.list("u1", dir).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("addAlways atomicity", () => {
  it("counts and inserts in one transaction", () => {
    const { service, db } = bed;
    const seen: string[] = [];
    const original = db.transaction.bind(db);
    db.transaction = ((fn: () => unknown) => {
      seen.push("begin");
      return original(fn);
    }) as typeof db.transaction;
    service.addAlways(rule);
    expect(seen).toEqual(["begin"]);
  });
});
