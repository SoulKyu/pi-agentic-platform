import { MAX_ALWAYS_RULES, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed, KEY, keyOf } from "./testing/bed.ts";

let bed: ReturnType<typeof makeBed>;
const makeBed = () => {
  const base = createPolicyBed();
  const store = createPolicyStore(base.db);
  const service = createPolicyService({
    store,
    clock: base.clock,
    logger: base.logger,
    newId: base.newId,
    audit: base.audit,
  });
  return { ...base, store, service };
};
beforeEach(() => {
  bed = makeBed();
});
afterEach(() => bed.dispose());

const rule = { ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "bash: npm test" };

describe("policy service", () => {
  it("adds a rule once per exact call, lists it per owner and project, and refuses past 1000", () => {
    const { service } = bed;
    expect(service.addAlways(rule)).toBe("added");
    expect(service.addAlways(rule)).toBe("exists");
    expect(service.rulesFor("u1", "/w")).toEqual([{ tool: "bash", key: KEY }]);
    expect(service.rulesFor("u2", "/w")).toEqual([]);
    expect(service.rulesFor("u1", "/other")).toEqual([]);
    for (let i = 1; i < MAX_ALWAYS_RULES; i++) service.addAlways({ ...rule, key: keyOf(i) });
    // Full, but an existing rule is still "exists", never "full" (M2-RT-24).
    expect(service.addAlways(rule)).toBe("exists");
    expect(service.addAlways({ ...rule, key: "f".repeat(64) })).toBe("full");
  });

  it("crosses the cap at 999, 1000 and 1001 rules", () => {
    const { service, store } = bed;
    for (let i = 0; i < MAX_ALWAYS_RULES - 1; i++) service.addAlways({ ...rule, key: keyOf(i + 1) });
    expect(store.count("u1", "/w")).toBe(999);
    expect(service.addAlways({ ...rule, key: keyOf(1000) })).toBe("added");
    expect(store.count("u1", "/w")).toBe(1000);
    expect(service.addAlways({ ...rule, key: keyOf(1001) })).toBe("full");
    expect(store.count("u1", "/w")).toBe(1000);
    expect(bed.lines.filter((l) => l.msg === "approval_rules_full")).toHaveLength(1);
    // The cap is per owner and project: another project, another owner, are not full.
    expect(service.addAlways({ ...rule, scope: "/other", key: keyOf(1001) })).toBe("added");
    expect(service.addAlways({ ...rule, ownerId: "u2", key: keyOf(1001) })).toBe("added");
  });

  it("cuts a label to 4096 characters", () => {
    bed.service.addAlways({ ...rule, label: "x".repeat(5000) });
    expect(bed.service.list("u1")[0]?.label).toHaveLength(4096);
  });

  it("revokes only its owner's rule and tells the listeners which project changed", () => {
    const { service } = bed;
    const changes: string[] = [];
    service.onChange((owner, scope) => void changes.push(`${owner}:${scope}`));
    service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" });
    const [listed] = service.list("u1");
    expect(listed).toMatchObject({ scope: "/w", tool: "bash", label: "l" });
    expect(() => service.revoke(testCaller({ userId: "u2" }), listed?.id ?? "")).toThrow(
      new PapError("not_found"),
    );
    expect(() => service.revoke(testCaller(), "nope")).toThrow(new PapError("not_found"));
    expect(changes).toEqual(["u1:/w"]);
    service.revoke(testCaller(), listed?.id ?? "");
    expect(service.rulesFor("u1", "/w")).toEqual([]);
    expect(changes).toEqual(["u1:/w", "u1:/w"]);
    expect(() => service.revoke(testCaller(), listed?.id ?? "")).toThrow(new PapError("not_found"));
  });

  it("keeps telling the other listeners when one throws, and logs it", () => {
    const { service, lines } = bed;
    const heard: string[] = [];
    service.onChange(() => {
      throw new Error("worker gone");
    });
    service.onChange((owner) => void heard.push(owner));
    expect(service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" })).toBe(
      "added",
    );
    expect(heard).toEqual(["u1"]);
    expect(lines.filter((l) => l.msg === "policy_listener_failed")).toHaveLength(1);
    expect(service.rulesFor("u1", "/w")).toHaveLength(1);
  });

  it("stops telling a listener that was removed", () => {
    const { service } = bed;
    const heard: string[] = [];
    const off = service.onChange((owner) => void heard.push(owner));
    off();
    off();
    service.addAlways(rule);
    expect(heard).toEqual([]);
  });

  it("lists newest first", async () => {
    const { service, clock } = bed;
    for (const [i, scope] of ["/a", "/b", "/a"].entries()) {
      await clock.advance(10);
      service.addAlways({ ...rule, scope, key: keyOf(i + 1) });
    }
    const listed = service.list("u1");
    expect(listed.map((r) => [r.id, r.createdAt - (listed[2]?.createdAt ?? 0)])).toEqual([
      ["r3", 20],
      ["r2", 10],
      ["r1", 0],
    ]);
    expect(service.list("u2")).toEqual([]);
  });
});
