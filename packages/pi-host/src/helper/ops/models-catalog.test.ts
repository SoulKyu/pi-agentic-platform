import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { refreshCatalog, refreshCatalogOp } from "./models-catalog.ts";

interface FakeRuntime {
  refresh: ReturnType<typeof vi.fn>;
  getProviders(): Array<{ id: string; refreshModels?: () => Promise<void> }>;
  getModels(id: string): Array<{ id: string }>;
  checkAuth(id: string): Promise<{ type: string } | undefined>;
}
const fake = (steps: Array<{ ids: string[]; errors?: Map<string, Error>; aborted?: boolean }>) => {
  let step = -1;
  const runtime: FakeRuntime = {
    refresh: vi.fn(async () => {
      step++;
      const current = steps[step] ?? { ids: [] };
      return { aborted: current.aborted ?? false, errors: current.errors ?? new Map() };
    }),
    getProviders: () => [
      { id: "p", refreshModels: async () => {} },
      { id: "q", refreshModels: async () => {} },
      { id: "static" },
      { id: "nokey", refreshModels: async () => {} },
    ],
    getModels: (id) => (id === "p" ? (steps[Math.max(step, 0)]?.ids ?? []).map((m) => ({ id: m })) : []),
    checkAuth: async (id) => (id === "nokey" ? undefined : { type: "api_key" }),
  };
  return runtime;
};

describe("refreshCatalog", () => {
  it("does not refresh at all when offline", async () => {
    const runtime = fake([]);
    expect(await refreshCatalog(runtime as never, true)).toEqual({
      changed: false,
      offline: true,
      failedProviders: [],
    });
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("restores the cache without the network first, then forces a refresh with it", async () => {
    const runtime = fake([{ ids: ["a"] }, { ids: ["a", "b"] }]);
    expect(await refreshCatalog(runtime as never, false)).toEqual({
      changed: true,
      offline: false,
      failedProviders: [],
    });
    expect(runtime.refresh.mock.calls).toEqual([
      [{ allowNetwork: false }],
      [{ allowNetwork: true, force: true }],
    ]);
  });

  it("reports no change when the list is the same", async () => {
    const runtime = fake([{ ids: ["a", "b"] }, { ids: ["a", "b"] }]);
    expect(await refreshCatalog(runtime as never, false)).toEqual({
      changed: false,
      offline: false,
      failedProviders: [],
    });
  });

  it("reports a change when a model disappears", async () => {
    const runtime = fake([{ ids: ["a", "b"] }, { ids: ["a"] }]);
    expect((await refreshCatalog(runtime as never, false)).changed).toBe(true);
  });

  it("fails when the refresh was aborted", async () => {
    const runtime = fake([{ ids: ["a"] }, { ids: ["a"], aborted: true }]);
    await expect(refreshCatalog(runtime as never, false)).rejects.toMatchObject({ code: "failed" });
  });

  it("answers with the failed providers when some of those asked failed, whatever changed", async () => {
    const errors = new Map([["q", new Error("secret detail sk-123")]]);
    const same = fake([{ ids: ["a"] }, { ids: ["a"], errors }]);
    const answer = await refreshCatalog(same as never, false);
    expect(answer).toEqual({ changed: false, offline: false, failedProviders: ["q"] });
    expect(JSON.stringify(answer)).not.toContain("sk-123");
    const changed = fake([{ ids: ["a"] }, { ids: ["a", "b"], errors }]);
    expect(await refreshCatalog(changed as never, false)).toEqual({
      changed: true,
      offline: false,
      failedProviders: ["q"],
    });
  });

  it("fails only when every provider asked failed and nothing changed; static and unconfigured ones are not asked", async () => {
    const both = new Map([
      ["p", new Error("a")],
      ["q", new Error("b")],
    ]);
    const failure = await refreshCatalog(
      fake([{ ids: ["a"] }, { ids: ["a"], errors: both }]) as never,
      false,
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "failed", message: "2 provider(s) failed to refresh" });
    expect(String((failure as Error).message)).not.toContain("a,");
    const changed = await refreshCatalog(
      fake([{ ids: ["a"] }, { ids: ["a", "b"], errors: both }]) as never,
      false,
    );
    expect(changed).toMatchObject({ changed: true, failedProviders: ["p", "q"] });
  });
});

describe("models.refreshCatalog", () => {
  let bed: ModelsBed;
  beforeEach(async () => {
    bed = await makeModelsBed();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await bed.cleanup();
  });

  it("answers offline with no request when PI_OFFLINE is set", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    expect(await refreshCatalogOp.run({}, bed.context())).toEqual({
      changed: false,
      offline: true,
      failedProviders: [],
    });
    expect(blockedAttempts).toEqual([]);
  });

  it("takes no params", () => {
    expect(refreshCatalogOp.params.safeParse({}).success).toBe(true);
    expect(refreshCatalogOp.params.safeParse({ force: true }).success).toBe(false);
  });
});
