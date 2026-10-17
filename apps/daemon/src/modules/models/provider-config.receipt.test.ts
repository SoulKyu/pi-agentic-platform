import type { HandlerContext, HandlerTable } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { modelsRpc } from "./rpc.ts";
import { modelsBed } from "./testing/bed.ts";

const REV = "a".repeat(64);
const OTHER_REV = "c".repeat(64);
const saved = { revision: "b".repeat(64), enabledModelsSynced: true };
const provider = (id: string, baseUrl = "https://example.test/v1") => ({
  id,
  api: "openai-completions",
  baseUrl,
  auth: { kind: "stored" },
  headers: [],
  models: [{ id: "m1" }],
});
const save = (id: string, mode = "create", baseUrl?: string, baseRevision = REV) => ({
  mode,
  id,
  provider: provider(id, baseUrl),
  baseRevision,
});

/** The dispatcher as the daemon builds it, over the models rpc table and a receipt store that remembers. */
function dispatching() {
  const bed = modelsBed(() => saved);
  const store = new Map<string, { method: string; result: unknown }>();
  const dispatch = createDispatcher({
    handlers: modelsRpc(bed.service) as unknown as HandlerTable,
    receipts: {
      find: (user, command) => store.get(`${user}/${command}`) ?? null,
      save: (user, command, method, result) => void store.set(`${user}/${command}`, { method, result }),
      purge: () => 0,
      readOnly: false,
    },
    logger: silentLogger,
  });
  const caller = testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
  const ctx: HandlerContext = {
    caller,
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  };
  const call = (method: string, params: unknown, commandId = "cmd-0001") =>
    dispatch({ id: 1, method, params, commandId }, ctx);
  const helperRuns = () => bed.calls.filter((c) => c.op.startsWith("models.provider.")).length;
  return { call, helperRuns, store, bed };
}

describe("a replayed command id binds the target (MP-RT-03)", () => {
  it("save.replay-other-target: another id, another mode or another revision is bad_request", async () => {
    const { call, helperRuns } = dispatching();
    expect((await call("models.provider.save", save("mine"))).ok).toBe(true);
    for (const other of [
      save("other"),
      save("mine", "update"),
      save("mine", "create", undefined, OTHER_REV),
    ]) {
      expect(await call("models.provider.save", other)).toEqual({
        id: 1,
        ok: false,
        error: { code: "bad_request" },
      });
    }
    expect(helperRuns()).toBe(1);
  });

  it("replay-same-target-returns-first: same id, mode and revision with another provider body gets the first receipt", async () => {
    const { call, helperRuns } = dispatching();
    const first = await call("models.provider.save", save("mine"));
    const replay = await call("models.provider.save", save("mine", "create", "https://other.test/v1"));
    expect(replay).toEqual(first);
    expect(helperRuns()).toBe(1);
  });

  it("the receipt holds the selector hash and the result, nothing of the provider body", async () => {
    const { call, store } = dispatching();
    await call("models.provider.save", {
      ...save("mine"),
      provider: {
        ...provider("mine"),
        headers: [{ name: "X-Team", value: { kind: "literal", text: "RECEIPT-MARKER" } }],
      },
    });
    const text = JSON.stringify([...store.values()]);
    expect(text).not.toContain("RECEIPT-MARKER");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("X-Team");
  });

  it("remove binds id, revision and alsoRemoveKey the same way", async () => {
    const { call, helperRuns } = dispatching();
    const remove = { id: "mine", baseRevision: REV, alsoRemoveKey: false };
    expect((await call("models.provider.remove", remove)).ok).toBe(true);
    for (const other of [
      { ...remove, id: "other" },
      { ...remove, baseRevision: OTHER_REV },
      { ...remove, alsoRemoveKey: true },
    ])
      expect(await call("models.provider.remove", other)).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    expect(await call("models.provider.remove", remove)).toMatchObject({ ok: true });
    expect(helperRuns()).toBe(1);
  });

  it("a command id used on save cannot be replayed on remove", async () => {
    const { call } = dispatching();
    await call("models.provider.save", save("mine"));
    expect(
      await call("models.provider.remove", { id: "mine", baseRevision: REV, alsoRemoveKey: false }),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});
