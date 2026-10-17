import { type AvailableModels, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { AVAILABLE_CACHE_KEYS, AVAILABLE_TTL_MS, createAvailableCache } from "./available.ts";
import { modelsBed } from "./testing/bed.ts";

const answer = (id: string): AvailableModels => ({
  models: [{ provider: "p", id, name: id, reasoning: false }],
  providers: [{ id: "p", name: "P" }],
  origin: "signed-in",
  truncated: false,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
const counting = (value: AvailableModels) => {
  let runs = 0;
  return {
    load: () => {
      runs++;
      return Promise.resolve(value);
    },
    runs: () => runs,
  };
};

describe("the available-models cache", () => {
  it("cache.hit: serves a value inside the TTL and loads again once it ended", async () => {
    const cache = createAvailableCache();
    const loader = counting(answer("a"));
    await cache.read("k", 1000, loader.load);
    await cache.read("k", 1000 + AVAILABLE_TTL_MS - 1, loader.load);
    expect(loader.runs()).toBe(1);
    await cache.read("k", 1000 + AVAILABLE_TTL_MS, loader.load);
    expect(loader.runs()).toBe(2);
  });

  it("cache.single-flight: concurrent reads of one key share one run, two keys run twice", async () => {
    const cache = createAvailableCache();
    const gate = deferred<AvailableModels>();
    let runs = 0;
    const load = () => {
      runs++;
      return gate.promise;
    };
    const first = cache.read("k", 0, load);
    const second = cache.read("k", 0, load);
    const other = cache.read("other", 0, load);
    expect(runs).toBe(2);
    gate.resolve(answer("a"));
    expect(await first).toEqual(answer("a"));
    expect(await second).toEqual(answer("a"));
    expect(await other).toEqual(answer("a"));
  });

  it("cache.write-during-read: a clear while a read is in flight keeps its result out of the cache", async () => {
    const cache = createAvailableCache();
    const old = deferred<AvailableModels>();
    const stale = cache.read("k", 0, () => old.promise);
    cache.clear();
    const fresh = counting(answer("new"));
    // The run in flight was forgotten by clear: a new read starts its own run.
    expect(await cache.read("k", 0, fresh.load)).toEqual(answer("new"));
    old.resolve(answer("old"));
    expect(await stale).toEqual(answer("old"));
    expect(await cache.read("k", 1, fresh.load)).toEqual(answer("new"));
    expect(fresh.runs()).toBe(1);
  });

  it("cache.write-during-read: the old run alone never stores after a clear", async () => {
    const cache = createAvailableCache();
    const old = deferred<AvailableModels>();
    const stale = cache.read("k", 0, () => old.promise);
    cache.clear();
    old.resolve(answer("old"));
    await stale;
    const next = counting(answer("new"));
    expect(await cache.read("k", 1, next.load)).toEqual(answer("new"));
    expect(next.runs()).toBe(1);
  });

  it("cache.cap: the 33rd distinct key is answered but not stored, expired entries never block a new key", async () => {
    const cache = createAvailableCache();
    const loader = counting(answer("a"));
    for (let index = 0; index < AVAILABLE_CACHE_KEYS; index++) await cache.read(`k${index}`, 0, loader.load);
    expect(loader.runs()).toBe(AVAILABLE_CACHE_KEYS);
    expect(await cache.read("extra", 1, loader.load)).toEqual(answer("a"));
    await cache.read("extra", 2, loader.load);
    expect(loader.runs()).toBe(AVAILABLE_CACHE_KEYS + 2);
    // A stored key is still served, and refreshing it is allowed when full.
    await cache.read("k0", 3, loader.load);
    expect(loader.runs()).toBe(AVAILABLE_CACHE_KEYS + 2);
    // After the TTL the old entries are swept and the new key is stored.
    const later = AVAILABLE_TTL_MS + 5;
    await cache.read("extra", later, loader.load);
    await cache.read("extra", later + 1, loader.load);
    expect(loader.runs()).toBe(AVAILABLE_CACHE_KEYS + 3);
  });

  it("cache.failure-not-cached: a rejected run is not kept, the next read runs again", async () => {
    const cache = createAvailableCache();
    await expect(cache.read("k", 0, () => Promise.reject(new PapError("timeout")))).rejects.toMatchObject({
      code: "timeout",
    });
    const loader = counting(answer("a"));
    expect(await cache.read("k", 1, loader.load)).toEqual(answer("a"));
    expect(loader.runs()).toBe(1);
  });
});

describe("models service: available", () => {
  const caller = testCaller();
  const listing = answer("m");
  const served = (call: { op: string }) => (call.op === "models.available" ? listing : { ok: true });
  const confirmed = (now: number) => testCaller({ stepUpUntil: now + 60_000 });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const availableRuns = (calls: Array<{ op: string }>) =>
    calls.filter((call) => call.op === "models.available").length;

  it("serves the second read from the cache and passes the cwd as the key", async () => {
    const { service, calls } = modelsBed(served);
    expect(await service.available(caller)).toEqual(listing);
    await service.available(caller);
    expect(availableRuns(calls)).toBe(1);
    await service.available(caller, "/w/api");
    expect(availableRuns(calls)).toBe(2);
    expect(calls.at(-1)?.options.cwd).toBe("/w/api");
    await service.available(caller, "/w/api");
    expect(availableRuns(calls)).toBe(2);
  });

  it("refuses a cwd outside the caller's projects as invalid_cwd before any helper run", async () => {
    const { service, calls } = modelsBed(served);
    expect(await codeOf(service.available(caller, "/etc"))).toBe("invalid_cwd");
    expect(await codeOf(service.available(testCaller({ userId: "u2" }), "/w/api"))).toBe("invalid_cwd");
    expect(calls).toEqual([]);
  });

  it("checks the cwd before the cache: a cwd the first user filled is still invalid_cwd for a user who does not cover it", async () => {
    const { service, calls } = modelsBed(served);
    expect(await service.available(caller, "/w/api")).toEqual(listing);
    expect(availableRuns(calls)).toBe(1);
    expect(await codeOf(service.available(testCaller({ userId: "u2" }), "/w/api"))).toBe("invalid_cwd");
    expect(availableRuns(calls)).toBe(1);
  });

  it("refuses a helper result with an extra field as helper_failed", async () => {
    const { service } = modelsBed(() => ({ ...listing, apiKey: "sk-X" }));
    expect(await codeOf(service.available(caller))).toBe("helper_failed");
  });

  it("does not cache a rejected helper run", async () => {
    let failing = true;
    const { service, calls } = modelsBed(() => (failing ? new PapError("timeout") : listing));
    expect(await codeOf(service.available(caller))).toBe("timeout");
    failing = false;
    expect(await service.available(caller)).toEqual(listing);
    expect(availableRuns(calls)).toBe(2);
  });

  const paths: Array<[string, (bed: ReturnType<typeof modelsBed>) => Promise<unknown>]> = [
    ["models.setEnabled", ({ service }) => service.setEnabled(caller, { op: { op: "clear" } })],
    ["models.setDefault", ({ service }) => service.setDefault(caller, { provider: "p", modelId: "m" })],
    ["models.setDefaultThinking", ({ service }) => service.setDefaultThinking(caller, { level: "low" })],
    [
      "models.config.save",
      ({ service, clock }) =>
        service.configSave(confirmed(clock.now()), { text: "{}", baseRevision: "0".repeat(64) }),
    ],
    [
      "models.setApiKey",
      ({ service, clock }) => service.setApiKey(confirmed(clock.now()), { provider: "p", key: "k" }),
    ],
    ["models.logout", ({ service }) => service.logout(caller, { provider: "p" })],
    ["models.refreshCatalog", ({ service }) => service.refreshCatalog()],
    [
      "the login flow's onSignedIn",
      async ({ service, clock }) => {
        await service.login(confirmed(clock.now()), { provider: "p", method: "oauth" });
        await settle();
      },
    ],
  ];
  for (const [name, write] of paths) {
    it(`available.invalidated-by-${name}`, async () => {
      const bed = modelsBed((call) =>
        call.op === "models.available"
          ? listing
          : call.op === "models.setEnabled"
            ? { patterns: null }
            : call.op === "models.config.save"
              ? { revision: "0".repeat(64), enabledModelsSynced: true }
              : call.op === "models.refreshCatalog"
                ? { changed: false, offline: true, failedProviders: [] }
                : { ok: true },
      );
      await bed.service.available(caller);
      await write(bed);
      await bed.service.available(caller);
      expect(availableRuns(bed.calls)).toBe(2);
    });
  }

  it("available.invalidated-by-a-failed-write: a write that fails may have changed the file", async () => {
    const bed = modelsBed((call) =>
      call.op === "models.available" ? listing : new PapError("helper_failed"),
    );
    await bed.service.available(caller);
    await codeOf(bed.service.setEnabled(caller, { op: { op: "clear" } }));
    await bed.service.available(caller);
    expect(availableRuns(bed.calls)).toBe(2);
  });

  it("available.write-during-read: a write that lands while a read runs is not hidden by that read", async () => {
    const first = deferred<AvailableModels>();
    let reads = 0;
    const bed = modelsBed((call) => {
      if (call.op !== "models.available") return { patterns: null };
      reads++;
      return reads === 1 ? first.promise : answer("after");
    });
    const slow = bed.service.available(caller);
    await bed.service.setEnabled(caller, { op: { op: "clear" } });
    first.resolve(answer("before"));
    expect((await slow).models[0]?.id).toBe("before");
    expect((await bed.service.available(caller)).models[0]?.id).toBe("after");
  });

  it("available.single-flight: concurrent first calls share one helper run", async () => {
    const gate = deferred<AvailableModels>();
    const bed = modelsBed((call) => (call.op === "models.available" ? gate.promise : { ok: true }));
    const all = [1, 2, 3, 4].map(() => bed.service.available(caller));
    gate.resolve(listing);
    expect((await Promise.all(all)).every((result) => result.models.length === 1)).toBe(true);
    expect(availableRuns(bed.calls)).toBe(1);
  });
});
