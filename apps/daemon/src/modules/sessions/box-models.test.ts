import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AvailableModels, type AvailableModelsData, MAX_LISTED_MODELS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../kernel/logger.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { BOX_MODELS_FILE, createBoxModels, refreshBoxModels } from "./box-models.ts";
import { createSessionModels, type SessionModelsDeps } from "./service-models.ts";

const model = (provider: string, id = `${provider}-1`) => ({
  provider,
  id,
  name: provider,
  reasoning: false,
});
const bridge = model("claude-bridge");
const picker: AvailableModels = {
  models: [model("acme")],
  providers: [{ id: "acme", name: "acme" }],
  origin: "scope",
  truncated: false,
};
const answer = (models: AvailableModelsData["models"]): AvailableModelsData => ({
  models,
  truncated: false,
  current: null,
});

let home: string;
let warnings: Array<[string, unknown]>;
let tick: number;
const logger: Logger = {
  ...silentLogger,
  warn: (msg, fields) => void warnings.push([msg, fields]),
  child: () => logger,
};
const store = (papHome: string | undefined = home) =>
  createBoxModels({ ...(papHome === undefined ? {} : { papHome }), now: () => ++tick, logger });
const fileOf = () => JSON.parse(readFileSync(join(home, BOX_MODELS_FILE), "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-box-models-"));
  warnings = [];
  tick = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the box models file", () => {
  it("is read back by a new instance on the same home (a restart)", () => {
    store().record("agent:a1", [bridge]);
    expect(store().get("agent:a1")).toEqual([bridge]);
    expect(fileOf()).toMatchObject({ version: 1, boxes: { "agent:a1": { models: [bridge] } } });
  });

  it("reads a missing file as empty without a warning", () => {
    expect(store().get("agent:a1")).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it.each([["not json"], [JSON.stringify({ version: 2, boxes: {} })], [JSON.stringify({ version: 1 })]])(
    "reads an invalid file as empty, says so once without its content, and the next write replaces it (%s)",
    (content) => {
      writeFileSync(join(home, BOX_MODELS_FILE), content);
      const boxes = store();
      expect(boxes.get("agent:a1")).toEqual([]);
      expect(boxes.get("agent:a2")).toEqual([]);
      expect(warnings).toEqual([["box_models_unreadable", {}]]);
      boxes.record("agent:a1", [bridge]);
      expect(fileOf()).toMatchObject({ version: 1, boxes: { "agent:a1": { models: [bridge] } } });
    },
  );

  it("keeps at most 200 boxes, dropping the oldest first", () => {
    const boxes = store();
    for (let i = 0; i < 201; i++) boxes.record(`agent:a${i}`, [bridge]);
    expect(boxes.get("agent:a0")).toEqual([]);
    expect(boxes.get("agent:a1")).toEqual([bridge]);
    expect(Object.keys(fileOf().boxes)).toHaveLength(200);
  });

  it("writes nothing when the list is unchanged, and keeps the whole list (500 at most)", () => {
    const boxes = store();
    boxes.record("agent:a1", [bridge]);
    writeFileSync(join(home, BOX_MODELS_FILE), "marker");
    boxes.record("agent:a1", [bridge]);
    expect(readFileSync(join(home, BOX_MODELS_FILE), "utf8")).toBe("marker");
    const many = Array.from({ length: MAX_LISTED_MODELS + 5 }, (_, i) => model("x", `m${i}`));
    boxes.record("agent:a2", many);
    expect(boxes.get("agent:a2")).toHaveLength(MAX_LISTED_MODELS);
  });

  it("a write that fails is said without failing the caller", () => {
    const boxes = store(join(home, "missing-folder"));
    expect(() => boxes.record("agent:a1", [bridge])).not.toThrow();
    expect(boxes.get("agent:a1")).toEqual([bridge]);
    expect(warnings.map(([msg]) => msg)).toEqual(["box_models_unwritable"]);
  });
});

describe("refreshBoxModels", () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("records the worker's list for the box without any menu call", async () => {
    const boxes = store();
    const command = vi.fn(async () => ({ ok: true as const, data: answer([model("acme"), bridge]) }));
    refreshBoxModels({ command, busy: () => false } as never, "agent:a1", boxes, logger);
    await flush();
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "get_available_models" });
    expect(boxes.get("agent:a1")).toEqual([model("acme"), bridge]);
  });

  it("asks a worker that already runs nothing: its run's start is left alone", async () => {
    const boxes = store();
    const command = vi.fn(async () => ({ ok: true as const, data: answer([bridge]) }));
    refreshBoxModels({ command, busy: () => true } as never, "agent:a1", boxes, logger);
    await flush();
    expect(command).not.toHaveBeenCalled();
    expect(boxes.get("agent:a1")).toEqual([]);
  });

  it.each([
    ["a refusal", async () => ({ ok: false as const, error: "secret worker words" })],
    ["a throw", async () => Promise.reject(new Error("secret worker words"))],
    ["an unreadable answer", async () => ({ ok: true as const, data: { nope: 1 } })],
  ])("%s is a warning with no worker text, and returns at once", async (_name, command) => {
    const boxes = store();
    refreshBoxModels({ command, busy: () => false } as never, "agent:a1", boxes, logger);
    await flush();
    expect(warnings).toEqual([["box_models_refresh_failed", {}]]);
    expect(boxes.get("agent:a1")).toEqual([]);
  });
});

describe("a cold agent menu", () => {
  const cold = (boxes: ReturnType<typeof store>, saved: { provider: string; modelId: string } | null) => {
    const providers = {
      sessionModels: vi.fn(async (_u: string, data: AvailableModelsData) => data),
      available: vi.fn(async () => picker),
    };
    const deps = {
      owned: () => ({ agentId: "a1" }) as never,
      runsInVm: () => true,
      running: async () => null,
      waiting: () => false,
      logger,
      providers,
      boxModels: boxes,
      savedModelOf: () => saved,
    } as unknown as SessionModelsDeps;
    return { models: createSessionModels(deps), providers };
  };

  it("lists the saved model, as current, with nothing cached", async () => {
    const t = cold(store(), { provider: "claude-bridge", modelId: "claude-sonnet-5-5" });
    const data = await t.models.models("s1", testCaller());
    expect(data.models.at(-1)).toEqual({
      provider: "claude-bridge",
      id: "claude-sonnet-5-5",
      name: "claude-sonnet-5-5",
      reasoning: false,
    });
    expect(data.current).toEqual({ provider: "claude-bridge", id: "claude-sonnet-5-5" });
  });

  it("does not list the saved model twice when the box's list holds it", async () => {
    const boxes = store();
    boxes.record("agent:a1", [bridge]);
    const t = cold(boxes, { provider: "claude-bridge", modelId: "claude-bridge-1" });
    const data = await t.models.models("s1", testCaller());
    expect(data.models.filter((m) => m.provider === "claude-bridge")).toEqual([bridge]);
    expect(data.current).toEqual({ provider: "claude-bridge", id: "claude-bridge-1" });
  });

  it("after a restart, still lists the extension models the previous instance kept", async () => {
    store().record("agent:a1", [model("acme"), bridge]);
    const t = cold(store(), null);
    const data = await t.models.models("s1", testCaller());
    expect(data.models).toEqual([model("acme"), bridge]);
    expect(data.current).toBeNull();
  });
});
