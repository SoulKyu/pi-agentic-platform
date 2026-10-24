import type { Caller, HandlerContext, HandlerTable } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { sha256Hex } from "../../kernel/ids.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { automationRpc } from "./rpc.ts";
import { createAutomationBed, type AutomationBed } from "./testing/bed.ts";

let bed: AutomationBed;
const noTasks = {
  cancel: async () => ({ taskId: "x" }),
  retry: () => ({ taskId: "x" }),
  releaseTools: async () => ({ taskId: "x", sessionId: "s" }),
  dismiss: () => {},
};
const unused = async (): Promise<never> => {
  throw new Error("not under test");
};
const noOperations = {
  manual: { fire: unused },
  dryRun: { run: unused },
  journal: { page: unused as never },
};
afterEach(() => bed.dispose());

function setup() {
  bed = createAutomationBed();
  const dispatch = createDispatcher({
    handlers: automationRpc(bed.triggers, noTasks, noOperations) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  let frameId = 0;
  const call = (method: string, params: unknown, caller: Caller, commandId?: string) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: () => "s",
      closeSubscription: () => {},
    };
    return dispatch({ id: ++frameId, method, params, ...(commandId ? { commandId } : {}) }, ctx);
  };
  return call;
}

const receiptRows = () =>
  bed.db.all<{ method: string; result: string }>("SELECT method, result FROM receipts");
const webhook = () => ({
  name: "Hook",
  source: { type: "webhook" },
  execution: { cwd: bed.folder },
  prompt: "Alert: {{payload}}",
});

describe("secrets in the receipts", () => {
  it("create shows the secret once; its receipt keeps neither the secret nor the input, and a replay answers conflict", async () => {
    const call = setup();
    const first = await call("automation.triggers.create", { input: webhook() }, bed.owner(), "cmd-create-1");
    expect(first.ok).toBe(true);
    const { trigger, secret } = (first as { result: { trigger: { id: string }; secret: string } }).result;
    expect(secret).toMatch(/^pwh_[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(receiptRows());
    expect(stored).not.toContain("pwh_");
    expect(stored).not.toContain(trigger.id);
    expect(JSON.parse(receiptRows()[0]?.result ?? "{}")).toEqual({
      paramsHash: sha256Hex("{}"),
      secret: true,
    });
    const replay = await call(
      "automation.triggers.create",
      { input: webhook() },
      bed.owner(),
      "cmd-create-1",
    );
    expect(replay).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(JSON.stringify(replay)).not.toContain("pwh_");
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers")?.n).toBe(1);
  });

  it("update and rotateSecret keep no secret in their receipts either, and replays answer conflict", async () => {
    const call = setup();
    const created = (await call("automation.triggers.create", { input: webhook() }, bed.owner(), "c1")) as {
      result: { trigger: { id: string; revision: number } };
    };
    const triggerId = created.result.trigger.id;
    const updated = await call(
      "automation.triggers.update",
      { triggerId, baseRevision: 1, input: { ...webhook(), name: "Renamed" } },
      bed.owner(),
      "c2",
    );
    expect(updated).toMatchObject({ ok: true, result: { secret: null, trigger: { revision: 2 } } });
    const rotated = (await call("automation.triggers.rotateSecret", { triggerId }, bed.owner(), "c3")) as {
      result: { secret: string };
    };
    expect(rotated.result.secret).toMatch(/^pwh_/);
    const stored = JSON.stringify(receiptRows());
    expect(stored).not.toContain("pwh_");
    for (const [method, params, commandId] of [
      [
        "automation.triggers.update",
        { triggerId, baseRevision: 1, input: { ...webhook(), name: "Renamed" } },
        "c2",
      ],
      ["automation.triggers.rotateSecret", { triggerId }, "c3"],
    ] as const)
      expect(await call(method, params, bed.owner(), commandId), method).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    expect(receiptRows().filter((receipt) => receipt.method.startsWith("automation.triggers.")).length).toBe(
      3,
    );
  });
});

describe("the handlers", () => {
  it("answer errors with their stable codes", async () => {
    const call = setup();
    expect(
      await call("automation.triggers.create", { input: webhook() }, bed.unconfirmed(), "a"),
    ).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    expect(await call("automation.triggers.get", { triggerId: "nope" }, bed.owner())).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await call(
        "automation.triggers.create",
        { input: { ...webhook(), execution: { cwd: bed.home } } },
        bed.owner(),
        "b",
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_cwd" } });
    expect(await call("automation.triggers.create", { input: { name: "" } }, bed.owner(), "c")).toMatchObject(
      {
        ok: false,
        error: { code: "bad_request" },
      },
    );
  });

  it("refuses a precheck, its variable names and {{precheck}} on save, and writes nothing (B6)", async () => {
    const call = setup();
    const inputs = [
      { ...webhook(), execution: { cwd: bed.folder, precheck: "check.sh" } },
      { ...webhook(), execution: { cwd: bed.folder, precheck: "check.sh", env: ["GH_HOST"] } },
      { ...webhook(), prompt: "Out: {{precheck}}" },
    ];
    for (const [index, input] of inputs.entries())
      expect(await call("automation.triggers.create", { input }, bed.owner(), `pre${index}`)).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers")?.n).toBe(0);
  });

  it("list, get and setEnabled answer views the contract accepts, an unreadable one included", async () => {
    const call = setup();
    const created = (await call("automation.triggers.create", { input: webhook() }, bed.owner(), "c1")) as {
      result: { trigger: { id: string } };
    };
    const triggerId = created.result.trigger.id;
    expect(
      await call("automation.triggers.setEnabled", { triggerId, enabled: true }, bed.unconfirmed(), "c2"),
    ).toMatchObject({
      ok: true,
      result: { id: triggerId, enabled: true, state: "ok" },
    });
    expect(await call("automation.triggers.get", { triggerId }, bed.owner())).toMatchObject({
      ok: true,
      result: { id: triggerId },
    });
    bed.db.run("UPDATE triggers SET config = '{}' WHERE id = $id", { id: triggerId });
    expect(await call("automation.triggers.list", {}, bed.owner())).toMatchObject({
      ok: true,
      result: { truncated: false, triggers: [{ id: triggerId, state: "unreadable", source: null }] },
    });
    expect(await call("automation.triggers.delete", { triggerId }, bed.unconfirmed(), "c3")).toMatchObject({
      ok: true,
      result: { ok: true },
    });
  });

  it("a token reads a redacted view and is refused every write", async () => {
    const call = setup();
    const created = (await call("automation.triggers.create", { input: webhook() }, bed.owner(), "c1")) as {
      result: { trigger: { id: string } };
    };
    const triggerId = created.result.trigger.id;
    const token = bed.token();
    const got = await call("automation.triggers.get", { triggerId }, token);
    expect(got).toMatchObject({
      ok: true,
      result: { redacted: true, execution: { precheck: null, env: [] } },
    });
    const writes: Array<[string, unknown]> = [
      ["automation.triggers.create", { input: webhook() }],
      ["automation.triggers.update", { triggerId, baseRevision: 1, input: webhook() }],
      ["automation.triggers.delete", { triggerId }],
      ["automation.triggers.setEnabled", { triggerId, enabled: true }],
      ["automation.triggers.rotateSecret", { triggerId }],
    ];
    for (const [method, params] of writes)
      expect(await call(method, params, token, `tok-${method}`), method).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers")?.n).toBe(1);
  });
});
