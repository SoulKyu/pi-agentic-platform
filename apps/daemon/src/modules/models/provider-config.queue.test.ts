import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsBed } from "./testing/bed.ts";

const REV = "a".repeat(64);
const saved = { revision: "b".repeat(64), enabledModelsSynced: true };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
/** Lets every promise chain that is ready run to its next real wait. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const body = {
  mode: "create" as const,
  id: "mine",
  provider: {
    id: "mine",
    api: "openai-completions" as const,
    baseUrl: "https://example.test/v1",
    auth: { kind: "stored" as const },
    headers: [],
    models: [{ id: "m1" }],
  },
  baseRevision: REV,
};

function queued(gate: { promise: Promise<unknown> }, gatedOp: string) {
  const bed = modelsBed((call) => {
    if (call.op === gatedOp) return gate.promise;
    if (call.op === "auth.logout") return { ok: true };
    return saved;
  });
  const caller = testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
  return { ...bed, caller, ops: () => bed.calls.map((call) => call.op) };
}

describe("provider writes share the one Pi write queue with models.config.save (MC28, MC29)", () => {
  it("provider.save-waits-for-config-save: a config save in flight holds the provider save back", async () => {
    const gate = deferred<unknown>();
    const { service, caller, ops } = queued(gate, "models.config.save");
    const config = service.configSave(caller, { text: "{}", baseRevision: REV });
    const provider = service.providerForm.save(caller, body);
    await flush();
    expect(ops()).toEqual(["models.config.save"]);
    gate.resolve(saved);
    await Promise.all([config, provider]);
    expect(ops()).toEqual(["models.config.save", "models.provider.save"]);
  });

  it("config-save-waits-for-provider.save: and the other way round", async () => {
    const gate = deferred<unknown>();
    const { service, caller, ops } = queued(gate, "models.provider.save");
    const provider = service.providerForm.save(caller, body);
    const config = service.configSave(caller, { text: "{}", baseRevision: REV });
    await flush();
    expect(ops()).toEqual(["models.provider.save"]);
    gate.resolve(saved);
    await Promise.all([config, provider]);
    expect(ops()).toEqual(["models.provider.save", "models.config.save"]);
  });

  it("remove.with-key-one-slot: no other write runs between the removal and the sign-out", async () => {
    const gate = deferred<unknown>();
    const { service, caller, ops } = queued(gate, "models.provider.remove");
    const removal = service.providerForm.remove(caller, {
      id: "mine",
      baseRevision: REV,
      alsoRemoveKey: true,
    });
    const config = service.configSave(caller, { text: "{}", baseRevision: REV });
    const save = service.providerForm.save(caller, body);
    await flush();
    expect(ops()).toEqual(["models.provider.remove"]);
    gate.resolve(saved);
    await Promise.all([removal, config, save]);
    expect(ops()).toEqual([
      "models.provider.remove",
      "auth.logout",
      "models.config.save",
      "models.provider.save",
    ]);
  });

  it("a full queue refuses a provider write with capacity, and nothing is dropped silently", async () => {
    const gate = deferred<unknown>();
    const { service, caller, audit } = queued(gate, "models.provider.save");
    const pending = Array.from({ length: 8 }, () => service.providerForm.save(caller, body));
    await flush();
    const refused = await service.providerForm.save(caller, body).then(
      () => "resolved",
      (error: unknown) => (error instanceof PapError ? error.code : "other"),
    );
    expect(refused).toBe("capacity");
    gate.resolve(saved);
    await Promise.all(pending);
    expect(audit).toHaveLength(8);
  });
});
