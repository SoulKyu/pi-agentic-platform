import { afterEach, describe, expect, it } from "vitest";
import { methods, type HandlerContext } from "@pap/contracts";
import { testCaller } from "../../testing/caller.ts";
import { createAuditModule } from "./index.ts";
import { createAuditBed } from "./testing/bed.ts";

let current: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => current?.dispose());

const ctxOf = (userId: string): HandlerContext => ({
  caller: testCaller({ userId }),
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});

describe("audit.list", () => {
  it("answers the caller's rows and the system's, as views the contract accepts", async () => {
    current = createAuditBed();
    const module = createAuditModule({ db: current.db, clock: current.clock, logger: current.logger });
    module.port.append({
      ownerId: "u1",
      actor: "user",
      kind: "policy",
      reason: "mode_changed",
      sessionId: "s1",
    });
    module.port.append({ ownerId: "u2", actor: "user", kind: "policy", reason: "other" });
    module.port.append({ ownerId: null, actor: "system", kind: "audit", reason: "boot" });
    const result = await module.rpc["audit.list"]({}, ctxOf("u1"));
    expect(methods["audit.list"].result.parse(result)).toEqual(result);
    expect(result.entries.map((e) => e.reason)).toEqual(["boot", "mode_changed"]);
    const scoped = await module.rpc["audit.list"]({ sessionId: "s1" }, ctxOf("u1"));
    expect(scoped.entries.map((e) => e.reason)).toEqual(["mode_changed"]);
    expect((await module.rpc["audit.list"]({}, ctxOf("u3"))).entries.map((e) => e.reason)).toEqual(["boot"]);
  });
});
