import { describe, expect, it } from "vitest";
import {
  AgentsSettings,
  ChildView,
  HELPER_OPS,
  methods,
  SubagentProfile,
  SubagentProfileFile,
  SubagentsProfilesResult,
} from "./index.ts";

const NONE = { parse: 0, refused: 0, tooLarge: 0 };
const ok = { name: "scout", description: "Fast recon", source: "user" } as const;

describe("subagent profiles (M11R135)", () => {
  it("accepts a profile and refuses an unknown key", () => {
    expect(SubagentProfile.safeParse(ok).success).toBe(true);
    expect(SubagentProfile.safeParse({ ...ok, systemPrompt: "x" }).success).toBe(false);
    expect(
      SubagentsProfilesResult.safeParse({
        profiles: [{ ...ok, path: "/x" }],
        truncated: false,
        skipped: NONE,
      }).success,
    ).toBe(false);
  });

  it("carries the skipped counts, strict, and refuses a result without them", () => {
    const profiles = [ok];
    const parsed = SubagentsProfilesResult.safeParse({ profiles, truncated: false, skipped: NONE });
    expect(parsed.success).toBe(true);
    expect(SubagentsProfilesResult.safeParse({ profiles, truncated: false }).success).toBe(false);
    for (const skipped of [
      { ...NONE, extra: 1 },
      { ...NONE, parse: -1 },
      { ...NONE, tooLarge: 1.5 },
      { parse: 0 },
    ])
      expect(SubagentsProfilesResult.safeParse({ profiles, truncated: false, skipped }).success).toBe(false);
  });

  it.each(["", "a b", "a/b", "../x", "a\u0000b", "é", "x".repeat(65)])("refuses the name %j", (name) => {
    expect(SubagentProfile.safeParse({ ...ok, name }).success).toBe(false);
  });

  it("accepts the characters of a file name", () => {
    expect(SubagentProfile.safeParse({ ...ok, name: "Plan_er-2.v1" }).success).toBe(true);
  });

  it("refuses a source that is neither user nor project", () => {
    expect(SubagentProfile.safeParse({ ...ok, source: "package" }).success).toBe(false);
  });

  it("declares subagents.profiles as an idempotent sessions:read query on a session", () => {
    expect(methods["subagents.profiles"]).toMatchObject({ permission: "sessions:read", idempotent: true });
    expect(methods["subagents.profiles"].params.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(methods["subagents.profiles"].params.safeParse({ sessionId: "s1", cwd: "/x" }).success).toBe(
      false,
    );
  });

  it("gives the helper op an offline switch that must be true", () => {
    const { params } = HELPER_OPS["subagents.profiles"];
    expect(params.safeParse({ offline: true }).success).toBe(true);
    expect(params.safeParse({}).success).toBe(false);
    expect(params.safeParse({ offline: false }).success).toBe(false);
  });
});

describe("one profile read whole (Task 29b, carry 1)", () => {
  const file = { ...ok, tools: ["read", "grep"], model: "fast", prompt: "You scout." };

  it("takes a name and the offline switch, and nothing else", () => {
    const { params } = HELPER_OPS["subagents.profile"];
    expect(params.safeParse({ offline: true, name: "scout" }).success).toBe(true);
    expect(params.safeParse({ offline: true }).success).toBe(false);
    expect(params.safeParse({ offline: false, name: "scout" }).success).toBe(false);
    expect(params.safeParse({ offline: true, name: "../x" }).success).toBe(false);
    expect(params.safeParse({ offline: true, name: "scout", cwd: "/x" }).success).toBe(false);
  });

  it("answers the profile with its tools, model and prompt, strictly", () => {
    expect(SubagentProfileFile.safeParse(file).success).toBe(true);
    expect(SubagentProfileFile.safeParse({ ...file, tools: null, model: null }).success).toBe(true);
    expect(SubagentProfileFile.safeParse({ ...file, extra: 1 }).success).toBe(false);
    expect(SubagentProfileFile.safeParse({ ...file, tools: ["../etc"] }).success).toBe(false);
    expect(SubagentProfileFile.safeParse({ ...file, prompt: "x".repeat(32 * 1024 + 1) }).success).toBe(false);
  });
});

describe("the subagents setting (owner m12)", () => {
  it("is on with two at once by default", () => {
    expect(AgentsSettings.parse({}).subagents).toEqual({ enabled: true, maxConcurrent: 2 });
    expect(AgentsSettings.parse({ subagents: { enabled: false } }).subagents).toEqual({
      enabled: false,
      maxConcurrent: 2,
    });
  });

  it("bounds the concurrency to 1..4", () => {
    for (const maxConcurrent of [0, 5, 1.5, "2"])
      expect(AgentsSettings.safeParse({ subagents: { maxConcurrent } }).success).toBe(false);
    for (const maxConcurrent of [1, 4])
      expect(AgentsSettings.parse({ subagents: { maxConcurrent } }).subagents.maxConcurrent).toBe(
        maxConcurrent,
      );
  });
});

describe("what the parent's screen shows of a child", () => {
  it("is strict and knows the six states", () => {
    const view = { id: "c1", runId: "r1", title: "Look", profile: null, state: "running", costUsd: 0.5 };
    expect(ChildView.safeParse(view).success).toBe(true);
    expect(ChildView.safeParse({ ...view, state: "paused" }).success).toBe(false);
    expect(ChildView.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(ChildView.safeParse({ ...view, costUsd: -1 }).success).toBe(false);
  });

  it("names the run, so Stop can reach it, and refuses a view without it", () => {
    const view = { id: "c1", title: "Look", profile: null, state: "running", costUsd: 0.5 };
    expect(ChildView.safeParse(view).success).toBe(false);
    expect(ChildView.safeParse({ ...view, runId: "" }).success).toBe(false);
  });
});

describe("subagents.cancel (M11R153)", () => {
  it("is a non-idempotent sessions:operate command on a run", () => {
    expect(methods["subagents.cancel"]).toMatchObject({ permission: "sessions:operate", idempotent: false });
    expect(methods["subagents.cancel"].params.safeParse({ runId: "r1" }).success).toBe(true);
    for (const params of [{}, { runId: "" }, { runId: "r1", sessionId: "s1" }, { runId: "x".repeat(129) }])
      expect(methods["subagents.cancel"].params.safeParse(params).success).toBe(false);
  });
});
