import { type AvailableModels, type AvailableModelsData, MAX_LISTED_MODELS, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createSessionModels, type SessionModelsDeps } from "./service-models.ts";

const model = (provider: string) => ({ provider, id: `${provider}-1`, name: provider, reasoning: false });
const listed: AvailableModelsData = {
  models: [model("acme"), model("private")],
  truncated: false,
  current: { provider: "private", id: "private-1" },
};
const picker: AvailableModels = {
  models: [model("acme")],
  providers: [{ id: "acme", name: "acme" }],
  origin: "scope",
  truncated: false,
};

function make(
  options: { vm?: boolean; live?: boolean; row?: Record<string, unknown>; host?: AvailableModels } = {},
) {
  let up = options.live ?? true;
  const command = vi.fn(async () => ({ ok: true as const, data: listed }));
  const providers = {
    sessionModels: vi.fn(async (_userId: string, data: AvailableModelsData) => ({
      ...data,
      models: [model("acme")],
    })),
    available: vi.fn(async () => options.host ?? picker),
  };
  const ensureLive = vi.fn(async () => {
    up = true;
    return { command, busy: () => false } as never;
  });
  const deps = {
    owned: () => (options.row ?? {}) as never,
    ensureLive,
    runsInVm: () => options.vm ?? false,
    boxHomeOf: (row: { box?: string }) => row.box ?? null,
    running: async () => (up ? ({ command, busy: () => false } as never) : null),
    waiting: () => false,
    logger: silentLogger,
    providers,
  } as unknown as SessionModelsDeps;
  return {
    models: createSessionModels(deps),
    command,
    providers,
    ensureLive,
    setUp: (v: boolean) => (up = v),
  };
}

describe("sessions.models and sessions.availableModels (M14)", () => {
  it("hands the session's own list to the providers gate, for the caller's user", async () => {
    const { models, providers } = make();
    const caller = testCaller({ userId: "member1" });
    expect((await models.models("s1", caller)).models.map((m) => m.provider)).toEqual(["acme"]);
    expect(providers.sessionModels).toHaveBeenCalledWith("member1", listed);
  });

  it("an unreadable answer is still refused before the gate", async () => {
    const { models, command, providers } = make();
    command.mockResolvedValueOnce({ ok: true, data: { nope: 1 } as never });
    await expect(models.models("s1", testCaller())).rejects.toEqual(new PapError("command_failed"));
    expect(providers.sessionModels).not.toHaveBeenCalled();
  });

  it("availableModels asks the gate with the caller alone: no cwd, and no session worker", async () => {
    const { models, providers, command } = make();
    const caller = testCaller({ userId: "member1" });
    expect(await models.availableModels(caller)).toEqual(picker);
    expect(providers.available).toHaveBeenCalledExactlyOnceWith(caller);
    expect(command).not.toHaveBeenCalled();
  });
});

describe("a cold session in a VM answers its menu without starting the VM", () => {
  const bridge = model("claude-bridge");
  const live = (models: AvailableModelsData["models"]): AvailableModelsData => ({
    models,
    truncated: false,
    current: null,
  });
  const cold = (extra: Parameters<typeof make>[0] = {}) => make({ vm: true, live: false, ...extra });

  it("answers the host models then the box's cached extension models, starting nothing", async () => {
    const t = cold({ row: { agentId: "a1" } });
    t.setUp(true);
    t.command.mockResolvedValueOnce({ ok: true, data: live([model("acme"), bridge]) as never });
    await t.models.models("s1", testCaller());
    t.setUp(false);
    t.ensureLive.mockClear();
    t.providers.sessionModels.mockClear();
    const caller = testCaller({ userId: "u1" });
    await t.models.models("s1", caller);
    expect(t.ensureLive).not.toHaveBeenCalled();
    expect(t.providers.sessionModels).toHaveBeenCalledWith("u1", {
      models: [model("acme"), bridge],
      truncated: false,
      current: null,
    });
  });

  it("answers the host models alone when nothing is cached", async () => {
    const t = cold({ row: { agentId: "a1" } });
    await t.models.models("s1", testCaller());
    expect(t.ensureLive).not.toHaveBeenCalled();
    expect(t.providers.sessionModels).toHaveBeenCalledWith(expect.anything(), {
      models: picker.models,
      truncated: false,
      current: null,
    });
  });

  it("keeps the cache per box: another box, agent or project, does not use it", async () => {
    const agentRow = { agentId: "a1" };
    const t = cold({ row: agentRow });
    t.setUp(true);
    t.command.mockResolvedValueOnce({ ok: true, data: live([bridge]) as never });
    await t.models.models("s1", testCaller());
    t.setUp(false);
    for (const row of [{ agentId: "a2" }, { box: "/boxes/p1/home", cwd: "/boxes/p1/project" }]) {
      const other = cold({ row });
      await other.models.models("s1", testCaller());
      expect(other.providers.sessionModels.mock.calls[0]?.[1].models).toEqual(picker.models);
    }
  });

  it("a live VM session answers the worker's list, as before", async () => {
    const t = make({ vm: true, live: true, row: { agentId: "a1" } });
    await t.models.models("s1", testCaller());
    expect(t.command).toHaveBeenCalledOnce();
    expect(t.providers.sessionModels).toHaveBeenCalledWith(expect.anything(), listed);
    expect(t.providers.available).not.toHaveBeenCalled();
  });

  it("a cold session outside a VM still starts its worker", async () => {
    const t = make({ vm: false, live: false });
    await t.models.models("s1", testCaller());
    expect(t.ensureLive).toHaveBeenCalledOnce();
    expect(t.providers.available).not.toHaveBeenCalled();
  });

  it("cuts host plus extension models at 500 and says so", async () => {
    const many = Array.from({ length: MAX_LISTED_MODELS }, (_, i) => ({ ...model("acme"), id: `m${i}` }));
    const t = cold({
      row: { agentId: "a1" },
      host: { ...picker, models: many, providerIds: ["acme"] },
    });
    t.setUp(true);
    t.command.mockResolvedValueOnce({ ok: true, data: live([bridge]) as never });
    await t.models.models("s1", testCaller());
    t.setUp(false);
    await t.models.models("s1", testCaller());
    const data = t.providers.sessionModels.mock.calls.at(-1)?.[1];
    expect(data?.models).toHaveLength(MAX_LISTED_MODELS);
    expect(data?.truncated).toBe(true);
  });
});
