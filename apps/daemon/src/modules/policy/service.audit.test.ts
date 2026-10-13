import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createPolicyService } from "./service.ts";
import { createPolicyStore } from "./store.ts";
import { createPolicyBed, KEY } from "./testing/bed.ts";

let bed: ReturnType<typeof createPolicyBed>;
let service: ReturnType<typeof createPolicyService>;
beforeEach(() => {
  bed = createPolicyBed();
  service = createPolicyService({
    store: createPolicyStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
    audit: bed.audit,
  });
});
afterEach(() => bed.dispose());

const rule = { ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "bash: npm test" };

describe("rule revocation audit (M5R45)", () => {
  it("leaves one rule_revoked row naming the rule, its tool and who revoked it", () => {
    service.addAlways(rule);
    const [listed] = service.list("u1");
    const caller = testCaller({ credentialId: "dev1" });
    service.revoke(caller, listed?.id ?? "");
    expect(bed.audited).toEqual([
      {
        ownerId: "u1",
        actor: "user",
        actorId: "dev1",
        kind: "policy",
        reason: "rule_revoked",
        detail: { ruleId: listed?.id, tool: "bash" },
      },
    ]);
  });

  it("names a token as the actor, and audits nothing for a refused revocation", () => {
    service.addAlways(rule);
    const [listed] = service.list("u1");
    expect(() => service.revoke(testCaller({ userId: "u2" }), listed?.id ?? "")).toThrow(
      new PapError("not_found"),
    );
    expect(bed.audited).toEqual([]);
    service.revoke(testCaller({ kind: "token", credentialId: "tok1" }), listed?.id ?? "");
    expect(bed.audited).toMatchObject([{ actor: "token", actorId: "tok1" }]);
  });

  it("does not fail the revocation when the audit port throws (M5R47)", () => {
    const failing = createPolicyService({
      store: createPolicyStore(bed.db),
      clock: bed.clock,
      logger: bed.logger,
      newId: bed.newId,
      audit: {
        append: () => {
          throw new Error("disk");
        },
      },
    });
    failing.addAlways(rule);
    const [listed] = failing.list("u1");
    expect(() => failing.revoke(testCaller(), listed?.id ?? "")).not.toThrow();
    expect(failing.rulesFor("u1", "/w")).toEqual([]);
  });
});
