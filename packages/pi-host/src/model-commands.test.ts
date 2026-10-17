import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { WORKER_BUSY } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { handleGetAvailableModels, handleSetModel, handleSetThinking } from "./model-commands.ts";

type Sent = Record<string, unknown>;
const recorder = () => {
  const sent: Sent[] = [];
  return { sent, send: (record: Sent) => void sent.push(record) };
};

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  input: string[];
}
const modelOf = (id: string, reasoning = false, provider = "p"): FakeModel => ({
  provider,
  id,
  name: `Model ${id}`,
  reasoning,
  contextWindow: 1000,
  input: ["text"],
});

// Pi clamps a level the model lacks to the nearest one it has (agent-session.js setThinkingLevel).
const LEVELS_OF_REASONING = ["off", "minimal", "low", "medium", "high"];
function fakeSession(options: {
  models: FakeModel[];
  scoped?: FakeModel[];
  idle?: boolean;
  failSet?: boolean;
  /** Runs while the runtime lists its models: a prompt may arrive then. */
  whileListing?: (state: { idle: boolean }) => void;
}) {
  const state = {
    model: options.models[0] as FakeModel | undefined,
    level: "off",
    idle: options.idle ?? true,
  };
  const levels = () => (state.model?.reasoning ? LEVELS_OF_REASONING : ["off"]);
  const setModel = vi.fn(async (next: FakeModel) => {
    if (options.failSet) throw new Error("No API key for p/x");
    state.model = next;
    if (!next.reasoning) state.level = "off";
  });
  const session = {
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.level;
    },
    get isIdle() {
      return state.idle;
    },
    scopedModels: (options.scoped ?? []).map((model) => ({ model })),
    settingsManager: { getEnabledModels: () => undefined, reload: async () => {} },
    modelRuntime: {
      refresh: async () => ({}),
      getAvailable: async () => {
        await Promise.resolve();
        options.whileListing?.(state);
        return options.models;
      },
    },
    getActiveToolNames: () => ["read", "bash"],
    getAvailableThinkingLevels: levels,
    setModel,
    setThinkingLevel: (level: string) => {
      state.level = levels().includes(level) ? level : (levels().at(-1) ?? "off");
    },
  };
  return { session: session as unknown as AgentSession, setModel, state };
}

describe("get_available_models", () => {
  it("lists the runtime's models in Pi's order and names the current one", async () => {
    const { session } = fakeSession({ models: [modelOf("b", true), modelOf("a")] });
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    expect(sent).toEqual([
      { type: "loadout", loadout: expect.objectContaining({ model: expect.objectContaining({ id: "b" }) }) },
      {
        type: "response",
        id: "r1",
        command: "get_available_models",
        success: true,
        data: {
          models: [
            { provider: "p", id: "b", name: "Model b", reasoning: true, contextWindow: 1000, images: false },
            { provider: "p", id: "a", name: "Model a", reasoning: false, contextWindow: 1000, images: false },
          ],
          truncated: false,
          current: { provider: "p", id: "b" },
        },
      },
    ]);
  });

  it("returns at most 500 models and says it cut the list", async () => {
    const models = Array.from({ length: 501 }, (_, i) => modelOf(`m${i}`));
    const { session } = fakeSession({ models });
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    const data = (sent.at(-1) as { data: { models: unknown[]; truncated: boolean } }).data;
    expect(data.models).toHaveLength(500);
    expect(data.truncated).toBe(true);
    expect((data.models[499] as { id: string }).id).toBe("m499");
  });

  it("fits the list by bytes as well as by count, and says it cut it", async () => {
    // Control characters escape to six bytes each: 500 such names would pass the 1 MiB frame.
    const wide = (i: number) => ({ ...modelOf(`m${i}`), name: "\u0001".repeat(256) });
    const { session } = fakeSession({ models: Array.from({ length: 500 }, (_, i) => wide(i)) });
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    const data = (sent.at(-1) as { data: { models: unknown[]; truncated: boolean } }).data;
    expect(data.truncated).toBe(true);
    expect(data.models.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(data.models))).toBeLessThanOrEqual(600_000);
    expect((data.models[0] as { id: string }).id).toBe("m0");
  });

  it("lists only the scoped models when the session has a scope", async () => {
    const all = [modelOf("a"), modelOf("b"), modelOf("c")];
    const { session } = fakeSession({ models: all, scoped: [all[2] as FakeModel] });
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    const data = (sent.at(-1) as { data: { models: Array<{ id: string }> } }).data;
    expect(data.models.map((model) => model.id)).toEqual(["c"]);
  });

  it("leaves out a model a client could not be told about (a 300-character id)", async () => {
    const { session } = fakeSession({ models: [modelOf("x".repeat(300)), modelOf("ok")] });
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    const data = (sent.at(-1) as { data: { models: Array<{ id: string }> } }).data;
    expect(data.models.map((model) => model.id)).toEqual(["ok"]);
  });

  it("answers a failure of the runtime as a failed response", async () => {
    const session = {
      scopedModels: [],
      settingsManager: { getEnabledModels: () => undefined },
      modelRuntime: {
        getAvailable: async () => {
          throw new Error("auth store unreadable");
        },
      },
    } as unknown as AgentSession;
    const { sent, send } = recorder();
    await handleGetAvailableModels(session, { id: "r1" }, send);
    expect(sent).toEqual([
      {
        type: "response",
        id: "r1",
        command: "get_available_models",
        success: false,
        error: "auth store unreadable",
      },
    ]);
  });
});

describe("set_model", () => {
  it("switches for this session only, then tells the loadout before it answers", async () => {
    const models = [modelOf("a"), modelOf("b", true)];
    const { session, setModel, state } = fakeSession({ models });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "b" }, send);
    // No `persist`: Pi's settings.json is never written by a pick (M7R42).
    expect(setModel.mock.calls).toEqual([[models[1]]]);
    expect(state.model?.id).toBe("b");
    expect(sent.map((record) => record.type)).toEqual(["loadout", "response"]);
    expect(sent[0]).toMatchObject({
      loadout: { model: { id: "b", reasoning: true }, levels: LEVELS_OF_REASONING, thinkingLevel: "off" },
    });
    expect(sent[1]).toMatchObject({ id: "r1", command: "set_model", success: true });
  });

  it("refuses a model the session does not list and changes nothing", async () => {
    const { session, setModel } = fakeSession({ models: [modelOf("a")] });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "nope" }, send);
    await handleSetModel(session, { id: "r2", provider: "other", modelId: "a" }, send);
    expect(setModel).not.toHaveBeenCalled();
    expect(sent.map((record) => [record.type, record.success])).toEqual([
      ["response", false],
      ["response", false],
    ]);
  });

  it("refuses a model outside the session's scope", async () => {
    const all = [modelOf("a"), modelOf("b")];
    const { session, setModel } = fakeSession({ models: all, scoped: [all[0] as FakeModel] });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "b" }, send);
    expect(setModel).not.toHaveBeenCalled();
    expect(sent).toMatchObject([{ type: "response", success: false }]);
  });

  it("refuses with the busy marker while Pi is not idle (M7R43)", async () => {
    const { session, setModel } = fakeSession({ models: [modelOf("a")], idle: false });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "a" }, send);
    expect(setModel).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "set_model", success: false, error: WORKER_BUSY },
    ]);
  });

  it("refuses when a run starts while the list is being read, and switches nothing (M7R43)", async () => {
    const { session, setModel } = fakeSession({
      models: [modelOf("a"), modelOf("b")],
      whileListing: (state) => {
        state.idle = false;
      },
    });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "b" }, send);
    expect(setModel).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "set_model", success: false, error: WORKER_BUSY },
    ]);
  });

  it("answers Pi's refusal (no credentials) as a failure and sends no loadout", async () => {
    const { session } = fakeSession({ models: [modelOf("a")], failSet: true });
    const { sent, send } = recorder();
    await handleSetModel(session, { id: "r1", provider: "p", modelId: "a" }, send);
    expect(sent).toEqual([
      {
        type: "response",
        id: "r1",
        command: "set_model",
        success: false,
        error: "No API key for p/x",
      },
    ]);
  });
});

describe("set_thinking_level", () => {
  it("sets a level the model has, at any time", () => {
    const { session } = fakeSession({ models: [modelOf("r", true)], idle: false });
    const { sent, send } = recorder();
    handleSetThinking(session, { id: "r1", level: "high" }, send);
    expect(sent).toMatchObject([
      { type: "loadout", loadout: { thinkingLevel: "high" } },
      { type: "response", id: "r1", command: "set_thinking_level", success: true },
    ]);
  });

  it("clamps xhigh to what the model allows and the loadout says so", () => {
    const { session, state } = fakeSession({ models: [modelOf("r", true)] });
    const { sent, send } = recorder();
    handleSetThinking(session, { id: "r1", level: "xhigh" }, send);
    expect(state.level).toBe("high");
    expect(sent[0]).toMatchObject({
      loadout: { thinkingLevel: "high", levels: LEVELS_OF_REASONING },
    });
  });

  it("keeps a model without reasoning at off", () => {
    const { session } = fakeSession({ models: [modelOf("plain")] });
    const { sent, send } = recorder();
    handleSetThinking(session, { id: "r1", level: "high" }, send);
    expect(sent[0]).toMatchObject({ loadout: { thinkingLevel: "off", levels: ["off"] } });
  });

  it("answers a throwing session as a failure", () => {
    const session = {
      setThinkingLevel: () => {
        throw new Error("boom");
      },
    } as unknown as AgentSession;
    const { sent, send } = recorder();
    handleSetThinking(session, { id: "r1", level: "low" }, send);
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "set_thinking_level", success: false, error: "boom" },
    ]);
  });
});
