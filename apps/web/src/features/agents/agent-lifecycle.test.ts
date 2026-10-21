import type { AgentSummary } from "@pap/contracts";
import { VM_PHASES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { setLocale, t } from "../../i18n/index.ts";
import {
  agentLifecycle,
  COMPOSER_LIFECYCLES,
  LIFECYCLES,
  LIFECYCLE_TONE,
  vmPhaseLifecycle,
  type SessionWord,
} from "./agent-lifecycle.ts";

const agent = (patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
  ...patch,
});

describe("the lifecycle of an agent: one word for the header, the composer and the panel", () => {
  it("working: the agent runs, or its session does", () => {
    expect(agentLifecycle(agent({ state: "running" }), null, null)).toBe("working");
    expect(agentLifecycle(agent({ state: "running" }), "running", "running")).toBe("working");
    expect(agentLifecycle(agent(), "running", null)).toBe("working");
    expect(agentLifecycle(agent(), "running", "stopping")).toBe("working");
  });

  it("needs_input: something waits for the owner, whatever the VM does", () => {
    expect(agentLifecycle(agent({ state: "needs_input" }), "idle", "running")).toBe("needs_input");
    expect(agentLifecycle(agent({ state: "needs_input" }), "running", null)).toBe("needs_input");
    expect(agentLifecycle(agent({ state: "needs_input" }), "cold", "stopped")).toBe("needs_input");
  });

  it("waking: the session or the VM starts", () => {
    expect(agentLifecycle(agent(), "starting", null)).toBe("waking");
    expect(agentLifecycle(agent(), "cold", "starting")).toBe("waking");
    expect(agentLifecycle(agent(), null, "starting")).toBe("waking");
    expect(agentLifecycle(agent(), "starting", "starting")).toBe("waking");
  });

  it("parked: healthy and off after a run (VM stopped, or the worker released)", () => {
    expect(agentLifecycle(agent(), "cold", "stopped")).toBe("parked");
    expect(agentLifecycle(agent(), "idle", "stopped")).toBe("parked");
    expect(agentLifecycle(agent(), "cold", "stopping")).toBe("parked");
    expect(agentLifecycle(agent(), "releasing", "running")).toBe("parked");
    expect(agentLifecycle(agent(), "cold", null)).toBe("parked");
    expect(agentLifecycle(agent(), null, "stopped")).toBe("parked");
  });

  it("is ready, which is no badge at all, when it is on and has nothing to say", () => {
    expect(agentLifecycle(agent(), "idle", null)).toBeNull();
    expect(agentLifecycle(agent(), "idle", "running")).toBeNull();
    expect(agentLifecycle(agent(), null, "running")).toBeNull();
    expect(agentLifecycle(agent(), null, null)).toBeNull();
  });

  it("paused: the owner paused it, or its VM is paused", () => {
    expect(agentLifecycle(agent({ state: "paused", paused: true }), "cold", "stopped")).toBe("paused");
    expect(agentLifecycle(agent({ paused: true }), "idle", "running")).toBe("paused");
    expect(agentLifecycle(agent(), "idle", "paused")).toBe("paused");
  });

  it("failed and quarantined win over everything else", () => {
    expect(agentLifecycle(agent({ state: "failed" }), "cold", "stopped")).toBe("failed");
    expect(agentLifecycle(agent({ state: "failed" }), "running", "starting")).toBe("failed");
    expect(
      agentLifecycle(agent({ state: "quarantined", quarantined: true, paused: true }), "cold", "paused"),
    ).toBe("quarantined");
    expect(agentLifecycle(agent({ quarantined: true }), "running", null)).toBe("quarantined");
  });

  it("reaches every one of the seven states, and every session word and VM phase maps somewhere", () => {
    const seen = new Set<string>();
    const states: AgentSummary["state"][] = [
      "idle",
      "running",
      "needs_input",
      "failed",
      "paused",
      "quarantined",
    ];
    const sessions: (SessionWord | null)[] = [null, "cold", "starting", "idle", "running", "releasing"];
    const phases = [null, ...VM_PHASES];
    for (const state of states)
      for (const session of sessions)
        for (const phase of phases) {
          const found = agentLifecycle(agent({ state, paused: state === "paused" }), session, phase);
          if (found !== null) seen.add(found);
        }
    expect([...seen].sort()).toEqual([...LIFECYCLES].sort());
  });
});

describe("a VM phase alone (the VM settings page)", () => {
  it("names stopped and stopping parked, starting waking, paused paused; running says nothing", () => {
    expect(VM_PHASES.map((phase) => vmPhaseLifecycle(phase))).toEqual([
      "parked",
      "waking",
      null,
      "paused",
      "parked",
    ]);
  });
});

describe("tones and copy", () => {
  it("follows DESIGN.md: working is the agent colour, the waits are attention, the faults are errors", () => {
    expect(LIFECYCLE_TONE).toEqual({
      working: "run",
      needs_input: "att",
      waking: "mut",
      paused: "mut",
      parked: "mut",
      failed: "err",
      quarantined: "err",
    });
  });

  it("the composer says only what asks for an action or explains a delay", () => {
    expect([...COMPOSER_LIFECYCLES].sort()).toEqual(["needs_input", "paused", "waking"]);
  });

  it("each state has a word and a one-sentence tooltip in both languages, with no exclamation mark", () => {
    try {
      for (const locale of ["en", "fr"] as const) {
        setLocale(locale);
        for (const state of LIFECYCLES) {
          const word = t(`shell.agent.state.${state}`);
          const tip = t(`shell.agent.tip.${state}`);
          expect(word).not.toMatch(/^shell\./);
          expect(tip).not.toMatch(/^shell\./);
          expect(tip).not.toContain("!");
          expect(tip.match(/[.]/g)?.length).toBe(1);
        }
      }
    } finally {
      setLocale("en");
    }
  });
});
