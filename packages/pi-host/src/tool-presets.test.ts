import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PolicyRules, TOOL_PRESETS, WORKER_BUSY } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPresetKeeper, handleSetTools } from "./tool-preset-commands.ts";
import { applyPreset, CODING_TOOLS, presetOf, presetToolNames, withPreset } from "./tool-presets.ts";

const ALL = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function fakeSession(active: string[], options: { defaultTools?: string[]; idle?: boolean } = {}) {
  const calls: string[][] = [];
  let names = [...active];
  const session = {
    isIdle: options.idle ?? true,
    model: undefined,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off"],
    getActiveToolNames: () => [...names],
    setActiveToolsByName: (next: string[]) => {
      calls.push(next);
      names = [...next];
    },
    settingsManager: { getDefaultTools: () => options.defaultTools },
  };
  return { session: session as unknown as AgentSession, calls, active: () => names };
}

describe("presetToolNames (M7R74)", () => {
  it("names the coding tools of each preset, null for configured", () => {
    expect(presetToolNames("configured")).toBeNull();
    expect(presetToolNames("none")).toEqual([]);
    expect(presetToolNames("chat")).toEqual([]);
    expect([...(presetToolNames("read-only") ?? [])].sort()).toEqual(["find", "grep", "ls", "read"]);
    expect([...(presetToolNames("default") ?? [])].sort()).toEqual(["bash", "edit", "read", "write"]);
    expect([...(presetToolNames("full") ?? [])].sort()).toEqual([...ALL].sort());
  });

  it("answers every preset the contract lists", () => {
    for (const preset of TOOL_PRESETS) expect(() => presetToolNames(preset)).not.toThrow();
    expect([...CODING_TOOLS].sort()).toEqual([...ALL, "powershell"].sort());
  });
});

describe("applyPreset (M7R75)", () => {
  const MCP = "mcp__fix__lookup";

  it("drops bash for read-only and keeps MCP, codemode and an extension tool", () => {
    const { session, active } = fakeSession(["read", "bash", "edit", "write", MCP, "codemode", "ext_tool"]);
    applyPreset(session, "read-only");
    const now = active();
    expect(now).not.toContain("bash");
    expect(now).not.toContain("edit");
    expect(now).not.toContain("write");
    expect(now).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", MCP, "codemode", "ext_tool"]));
    expect(presetOf(session)).toBe("read-only");
  });

  it("keeps an extension tool its extension switched off switched off", () => {
    const { session, active } = fakeSession(["read", "bash", MCP]);
    applyPreset(session, "full");
    expect(active()).not.toContain("ext_tool");
    expect(active()).toEqual(expect.arrayContaining(ALL));
  });

  it("adds bash back for full", () => {
    const { session, active } = fakeSession(["read", "grep", "find", "ls", MCP]);
    applyPreset(session, "full");
    expect(active()).toEqual(expect.arrayContaining(["bash", "edit", "write", MCP]));
  });

  it("leaves only non-coding tools for none and chat", () => {
    for (const preset of ["none", "chat"] as const) {
      const { session, active } = fakeSession(["read", "bash", MCP, "ext_tool"]);
      applyPreset(session, preset);
      expect(active().sort()).toEqual([MCP, "ext_tool"].sort());
    }
  });

  it("does not write the active set again when it is already right", () => {
    const { session, calls } = fakeSession(["read", "grep", "find", "ls", MCP]);
    applyPreset(session, "read-only");
    applyPreset(session, "read-only");
    expect(calls).toEqual([]);
  });

  it("configured pins nothing at open, and restores Pi's default tools when asked", () => {
    const first = fakeSession(["read", "bash", "edit", "write"]);
    applyPreset(first.session, "configured");
    expect(first.calls).toEqual([]);
    const back = fakeSession(["read", "grep", "find", "ls", MCP]);
    applyPreset(back.session, "read-only");
    applyPreset(back.session, "configured", { restore: true });
    expect(back.active().sort()).toEqual(["bash", "edit", MCP, "read", "write"].sort());
  });

  it("restores the defaultTools setting: plain names replace, +/- entries edit the default", () => {
    const plain = fakeSession(["read", MCP], { defaultTools: ["read", "grep"] });
    applyPreset(plain.session, "configured", { restore: true });
    expect(plain.active().sort()).toEqual(["grep", MCP, "read"].sort());
    const edits = fakeSession(["read", MCP], { defaultTools: ["+ls", "-bash"] });
    applyPreset(edits.session, "configured", { restore: true });
    expect(edits.active().sort()).toEqual(["edit", "ls", MCP, "read", "write"].sort());
    const empty = fakeSession(["read", "bash", MCP], { defaultTools: [] });
    applyPreset(empty.session, "configured", { restore: true });
    expect(empty.active()).toEqual([MCP]);
  });
});

describe("withPreset: the worker's own preset reaches the rules (fail closed)", () => {
  const rules = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });

  it("pins the coding tools and sets the read-only flag for read-only", () => {
    const next = withPreset(rules, "read-only");
    expect(next?.readOnlyPreset).toBe(true);
    expect([...(next?.presetTools ?? [])].sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("keeps a read-only flag the daemon sent, whatever the worker holds", () => {
    expect(withPreset({ ...rules, readOnlyPreset: true }, "configured")?.readOnlyPreset).toBe(true);
  });

  it("pins an empty list for none and chat, which are not read-only presets", () => {
    for (const preset of ["none", "chat"] as const) {
      const next = withPreset(rules, preset);
      expect(next?.presetTools).toEqual([]);
      expect(next?.readOnlyPreset).toBe(false);
    }
  });

  it("changes nothing for configured and passes null through", () => {
    expect(withPreset(rules, "configured")).toEqual(rules);
    expect(withPreset(null, "read-only")).toBeNull();
  });

  it("ignores a presetTools list the daemon sent: the worker's own preset decides", () => {
    expect(withPreset({ ...rules, presetTools: ["bash"] }, "configured")?.presetTools).toBeNull();
  });
});

describe("handleSetTools", () => {
  const send = () => {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, fn: (record: Record<string, unknown>) => void sent.push(record) };
  };

  it("applies the preset in place, tells the loadout and answers ok", () => {
    const { session, active } = fakeSession(["read", "bash", "edit", "write"]);
    const out = send();
    handleSetTools(session, { id: "1", preset: "read-only" }, out.fn);
    expect(active()).not.toContain("bash");
    expect(out.sent.map((record) => record.type)).toEqual(["loadout", "response"]);
    expect(out.sent[1]).toMatchObject({ command: "set_tools", success: true });
  });

  it("refuses while a run goes on and changes nothing", () => {
    const { session, calls } = fakeSession(["read", "bash"], { idle: false });
    const out = send();
    handleSetTools(session, { id: "1", preset: "read-only" }, out.fn);
    expect(out.sent).toEqual([
      { type: "response", id: "1", command: "set_tools", success: false, error: WORKER_BUSY },
    ]);
    expect(calls).toEqual([]);
    expect(presetOf(session)).toBe("configured");
  });

  it("changes nothing when the write of the active set throws: the answer is a failure and the old preset holds", () => {
    const { session, active } = fakeSession(["read", "grep", "find", "ls"]);
    applyPreset(session, "read-only");
    (session as unknown as { setActiveToolsByName: () => void }).setActiveToolsByName = () => {
      throw new Error("boom");
    };
    const out = send();
    handleSetTools(session, { id: "1", preset: "full" }, out.fn);
    expect(out.sent).toMatchObject([{ type: "response", command: "set_tools", success: false }]);
    expect(presetOf(session)).toBe("read-only");
    expect(active()).not.toContain("bash");
    expect(
      withPreset(
        PolicyRules.parse({ profile: "interactive", approvalMode: "full-access" }),
        presetOf(session),
      )?.presetTools,
    ).toEqual(["read", "grep", "find", "ls"]);
  });

  it("refuses to cross the chat boundary in place, both ways", () => {
    const into = fakeSession(["read", "bash"]);
    const out = send();
    handleSetTools(into.session, { id: "1", preset: "chat" }, out.fn);
    expect(out.sent[0]).toMatchObject({ success: false });
    expect(into.calls).toEqual([]);
    const from = fakeSession([]);
    applyPreset(from.session, "chat");
    handleSetTools(from.session, { id: "2", preset: "full" }, out.fn);
    expect(out.sent[1]).toMatchObject({ success: false });
    expect(presetOf(from.session)).toBe("chat");
  });
});

describe("createPresetKeeper (M7R75)", () => {
  it("puts the preset back at every event that can rewrite the active tools, and only then writes", () => {
    const handlers = new Map<string, () => void>();
    const { session, active, calls } = fakeSession(["read", "bash", "edit", "write", "mcp__fix__lookup"]);
    applyPreset(session, "read-only");
    const keeper = createPresetKeeper(() => session) as unknown as {
      factory: (pi: { on: (event: string, handler: () => void) => void }) => void;
    };
    keeper.factory({ on: (event, handler) => void handlers.set(event, handler) });
    expect([...handlers.keys()].sort()).toEqual([
      "before_agent_start",
      "session_start",
      "session_tree",
      "turn_start",
    ]);
    for (const [event, handler] of handlers) {
      session.setActiveToolsByName([...active(), "bash", "write"]);
      handler();
      expect(active(), event).not.toContain("bash");
      expect(active(), event).not.toContain("write");
      expect(active(), event).toContain("mcp__fix__lookup");
    }
    const written = calls.length;
    handlers.get("turn_start")?.();
    expect(calls.length).toBe(written);
  });

  it("does nothing before the session exists, and never throws into the run", () => {
    const handlers: Array<() => void> = [];
    const keeper = createPresetKeeper(() => undefined) as unknown as {
      factory: (pi: { on: (event: string, handler: () => void) => void }) => void;
    };
    keeper.factory({ on: (_event, handler) => void handlers.push(handler) });
    expect(() => handlers.forEach((handler) => handler())).not.toThrow();
    let fail = false;
    const flaky = {
      ...(fakeSession(["read", "bash"]).session as object),
      getActiveToolNames: () => {
        if (fail) throw new Error("boom");
        return ["read", "bash"];
      },
      setActiveToolsByName: () => {},
    } as unknown as AgentSession;
    applyPreset(flaky, "none");
    fail = true;
    const failing = createPresetKeeper(() => flaky) as unknown as {
      factory: (pi: { on: (event: string, handler: () => void) => void }) => void;
    };
    const failingHandlers: Array<() => void> = [];
    failing.factory({ on: (_event, handler) => void failingHandlers.push(handler) });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => failingHandlers.forEach((handler) => handler())).not.toThrow();
      expect(write).toHaveBeenCalledWith(expect.stringContaining("preset not re-applied"));
    } finally {
      write.mockRestore();
    }
  });
});
