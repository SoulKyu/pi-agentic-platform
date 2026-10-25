import { type AvailableModels, type AvailableModelsData, PapError } from "@pap/contracts";
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

function make() {
  const command = vi.fn(async () => ({ ok: true as const, data: listed }));
  const providers = {
    sessionModels: vi.fn(async (_userId: string, data: AvailableModelsData) => ({
      ...data,
      models: [model("acme")],
    })),
    available: vi.fn(async () => picker),
  };
  const deps = {
    owned: () => ({}) as never,
    ensureLive: async () => ({ command, busy: () => false }) as never,
    waiting: () => false,
    logger: silentLogger,
    providers,
  } as unknown as SessionModelsDeps;
  return { models: createSessionModels(deps), command, providers };
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
