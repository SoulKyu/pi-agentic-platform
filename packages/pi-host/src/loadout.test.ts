import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionLoadout } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLoadoutWatcher, loadoutOf, rememberProjectTrust } from "./loadout.ts";

const sessionWith = (fields: Record<string, unknown>) =>
  ({
    model: {
      provider: "p",
      id: "m",
      name: "M",
      reasoning: true,
      contextWindow: 8000,
      input: ["text", "image"],
    },
    thinkingLevel: "medium",
    getAvailableThinkingLevels: () => ["off", "low", "medium"],
    getActiveToolNames: () => ["read", "bash"],
    ...fields,
  }) as unknown as AgentSession;

describe("loadoutOf", () => {
  it("describes the model, the level, the levels and the active tools", () => {
    const loadout = loadoutOf(sessionWith({}));
    expect(loadout).toEqual({
      model: { provider: "p", id: "m", name: "M", reasoning: true, contextWindow: 8000, images: true },
      thinkingLevel: "medium",
      levels: ["off", "low", "medium"],
      preset: "configured",
      tools: ["read", "bash"],
      toolsTruncated: false,
    });
    expect(SessionLoadout.safeParse(loadout).success).toBe(true);
  });

  it("carries the project trust the session opened with, and nothing before it was remembered (M7R105)", () => {
    const session = sessionWith({});
    expect("projectTrust" in loadoutOf(session)).toBe(false);
    rememberProjectTrust(session, { required: true, trusted: false });
    const loadout = loadoutOf(session);
    expect(loadout.projectTrust).toEqual({ required: true, trusted: false });
    expect(SessionLoadout.safeParse(loadout).success).toBe(true);
    expect("projectTrust" in loadoutOf(sessionWith({}))).toBe(false);
  });

  it("has no model when Pi has none", () => {
    expect(loadoutOf(sessionWith({ model: undefined })).model).toBeNull();
  });

  it("cuts 300 tools at 256 and says so, and clips a long tool name", () => {
    const names = Array.from({ length: 300 }, (_, i) => `tool-${i}`);
    const loadout = loadoutOf(sessionWith({ getActiveToolNames: () => [...names, "y".repeat(400)] }));
    expect(loadout.tools).toHaveLength(256);
    expect(loadout.toolsTruncated).toBe(true);
    expect(SessionLoadout.safeParse(loadout).success).toBe(true);
    const long = loadoutOf(sessionWith({ getActiveToolNames: () => ["y".repeat(400)] }));
    expect(long.tools[0]).toHaveLength(256);
  });

  it("names a model whose id is too long as no model rather than breaking the record", () => {
    const loadout = loadoutOf(
      sessionWith({ model: { provider: "p", id: "x".repeat(300), name: "n", reasoning: false, input: [] } }),
    );
    expect(loadout.model).toBeNull();
    expect(SessionLoadout.safeParse(loadout).success).toBe(true);
  });
});

describe("createLoadoutWatcher", () => {
  function install(session: AgentSession | undefined, sent: unknown[]) {
    const handlers = new Map<string, () => void>();
    const extension = createLoadoutWatcher(
      (record) => void sent.push(record),
      () => session,
    );
    if (typeof extension === "function") throw new Error("the watcher is a named inline extension");
    void extension.factory({
      on: (event: string, handler: () => void) => void handlers.set(event, handler),
    } as unknown as ExtensionAPI);
    return handlers;
  }

  it("sends the loadout on model_select and thinking_level_select", () => {
    const sent: unknown[] = [];
    const handlers = install(sessionWith({}), sent);
    expect([...handlers.keys()].toSorted()).toEqual(["model_select", "thinking_level_select"]);
    handlers.get("model_select")?.();
    handlers.get("thinking_level_select")?.();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: "loadout", loadout: { thinkingLevel: "medium" } });
  });

  it("says nothing before the session exists, and survives a session that throws", () => {
    const sent: unknown[] = [];
    install(undefined, sent).get("model_select")?.();
    const throwing = sessionWith({
      getActiveToolNames: () => {
        throw new Error("x");
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      install(throwing, sent).get("thinking_level_select")?.();
      expect(stderr).toHaveBeenCalledWith("pi-host: loadout not sent: x\n");
    } finally {
      stderr.mockRestore();
    }
    expect(sent).toEqual([]);
  });
});
