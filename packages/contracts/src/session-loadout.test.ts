import { describe, expect, it } from "vitest";
import {
  AvailableModelsData,
  methods,
  parseWorkerRecord,
  SessionLoadout,
  SessionStreamEvent,
  THINKING_LEVELS,
  TOOL_PRESETS,
} from "./index.ts";

const model = { provider: "scripted", id: "plain", name: "Plain", reasoning: false };
const loadout = {
  model,
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: ["read", "bash"],
  toolsTruncated: false,
};

describe("ModelSummary and SessionLoadout", () => {
  it("accepts a plain loadout and a session without a model", () => {
    expect(SessionLoadout.safeParse(loadout).success).toBe(true);
    expect(SessionLoadout.safeParse({ ...loadout, model: null }).success).toBe(true);
    expect(
      SessionLoadout.safeParse({
        ...loadout,
        model: { ...model, contextWindow: 200_000, images: true, reasoning: true },
      }).success,
    ).toBe(true);
  });

  it("refuses a model summary with a 300-character id", () => {
    expect(SessionLoadout.safeParse({ ...loadout, model: { ...model, id: "x".repeat(300) } }).success).toBe(
      false,
    );
    expect(SessionLoadout.safeParse({ ...loadout, model: { ...model, id: "x".repeat(256) } }).success).toBe(
      true,
    );
  });

  it("refuses 8 levels, an unknown level and an unknown preset", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(TOOL_PRESETS).toEqual(["configured", "none", "read-only", "default", "full", "chat"]);
    expect(SessionLoadout.safeParse({ ...loadout, levels: [...THINKING_LEVELS] }).success).toBe(true);
    expect(SessionLoadout.safeParse({ ...loadout, levels: [...THINKING_LEVELS, "off"] }).success).toBe(false);
    expect(SessionLoadout.safeParse({ ...loadout, thinkingLevel: "extreme" }).success).toBe(false);
    expect(SessionLoadout.safeParse({ ...loadout, preset: "everything" }).success).toBe(false);
  });

  it("bounds the tool list at 256 names", () => {
    const names = (count: number) => Array.from({ length: count }, (_, i) => `tool-${i}`);
    expect(SessionLoadout.safeParse({ ...loadout, tools: names(256) }).success).toBe(true);
    expect(SessionLoadout.safeParse({ ...loadout, tools: names(257) }).success).toBe(false);
    expect(SessionLoadout.safeParse({ ...loadout, tools: ["x".repeat(257)] }).success).toBe(false);
  });
});

describe("the loadout on the wire", () => {
  it("carries a loadout in the snapshot (null by default) and as an event", () => {
    const event = SessionStreamEvent.parse({ kind: "loadout", loadout });
    expect(event).toEqual({ kind: "loadout", loadout });
    expect(
      SessionStreamEvent.safeParse({ kind: "loadout", loadout: { ...loadout, levels: 5 } }).success,
    ).toBe(false);
  });

  it("passes the worker's loadout record through unjudged: the daemon parses it (M7R44)", () => {
    const hostile = { ...loadout, tools: Array.from({ length: 300 }, () => "t") };
    expect(parseWorkerRecord({ type: "loadout", loadout: hostile })).toEqual({
      type: "loadout",
      loadout: hostile,
    });
  });
});

describe("the model methods", () => {
  it("declares permissions and errors", () => {
    expect(methods["sessions.models"]).toMatchObject({ permission: "sessions:read", idempotent: true });
    expect(methods["sessions.setModel"]).toMatchObject({ permission: "sessions:operate", idempotent: false });
    expect(methods["sessions.setThinking"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
    });
    expect(methods["sessions.setModel"].errors).toEqual(
      expect.arrayContaining([
        "not_found",
        "session_busy",
        "capacity",
        "worker_failed",
        "command_failed",
        "timeout",
      ]),
    );
    expect(methods["sessions.setThinking"].errors).not.toContain("session_busy");
  });

  it("caps the model list at 500", () => {
    const list = (count: number) => Array.from({ length: count }, (_, i) => ({ ...model, id: `m${i}` }));
    const data = { truncated: false, current: null };
    expect(AvailableModelsData.safeParse({ ...data, models: list(500) }).success).toBe(true);
    expect(AvailableModelsData.safeParse({ ...data, models: list(501) }).success).toBe(false);
    expect(
      methods["sessions.models"].result.safeParse({
        ...data,
        models: list(500),
        current: { provider: "p", id: "i" },
      }).success,
    ).toBe(true);
  });
});
