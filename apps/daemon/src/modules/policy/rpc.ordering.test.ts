import { describe, expect, it } from "vitest";
import { policyRpc } from "./rpc.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { KEY, policyBed } from "./testing/bed.ts";

const bedOf = () =>
  policyBed(({ db, clock, logger, newId, audit }) => {
    const service = createPolicyService({ store: createPolicyStore(db), clock, logger, newId, audit });
    return { service, rpc: policyRpc(service) };
  });

describe("policy mutations change their state before their first await (M5R9)", () => {
  it("revokes before the handler's promise is awaited", async () => {
    const { service, rpc, changes, ctxOf, dispose } = bedOf();
    try {
      service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" });
      const [listed] = service.list("u1");
      const pending = rpc["policy.revokeRule"]({ ruleId: listed?.id ?? "" }, ctxOf("u1"));
      expect(service.rulesFor("u1", "/w")).toEqual([]);
      expect(changes).toEqual(["u1:/w", "u1:/w"]);
      await pending;
    } finally {
      dispose();
    }
  });
});
