import { describe, expect, it } from "vitest";
import {
  MEMORY_LIMITS,
  MemoryItemView,
  MemoryJournalView,
  MemoryScopeView,
  MemoryScopeRef,
  QUARANTINE_STEPS,
  StagedFactView,
  TOKEN_PERMISSIONS,
  methods,
} from "./index.ts";

const agentId = "atlas-1a2b";
const factId = "123e4567-e89b-42d3-a456-426614174000";

describe("memory methods (M11R147)", () => {
  it("are browser only except the status", () => {
    expect(methods["memory.status"].permission).toBe("memory:read");
    for (const name of ["scopes", "list", "forget", "save", "staged", "decide"] as const) {
      expect(methods[`memory.${name}`].permission).toBe("memory:admin");
      expect(TOKEN_PERMISSIONS).not.toContain(methods[`memory.${name}`].permission);
    }
  });

  it("reads are idempotent and requests are mutations", () => {
    for (const name of ["status", "scopes", "list", "staged"] as const)
      expect(methods[`memory.${name}`].idempotent).toBe(true);
    for (const name of ["forget", "save", "decide"] as const)
      expect(methods[`memory.${name}`].idempotent).toBe(false);
  });

  it("names the scope strictly: user, a safe project id, an agent id", () => {
    expect(MemoryScopeRef.safeParse({ kind: "user" }).success).toBe(true);
    expect(MemoryScopeRef.safeParse({ kind: "project", id: "my.proj-1" }).success).toBe(true);
    expect(MemoryScopeRef.safeParse({ kind: "agent", id: agentId }).success).toBe(true);
    for (const bad of [
      { kind: "user", id: "x" },
      { kind: "project", id: "a..b" },
      { kind: "project", id: "a/b" },
      { kind: "project", id: "" },
      { kind: "agent", id: "../x" },
      { kind: "agent", id: "Atlas" },
      { kind: "team", id: "x" },
    ])
      expect(MemoryScopeRef.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("caps forget at 50 ids and refuses an empty or unsafe one", () => {
    const forget = methods["memory.forget"].params;
    const scope = { kind: "user" };
    expect(forget.safeParse({ scope, ids: ["m1"] }).success).toBe(true);
    expect(forget.safeParse({ scope, ids: Array.from({ length: 50 }, (_, i) => `m${i}`) }).success).toBe(
      true,
    );
    expect(forget.safeParse({ scope, ids: Array.from({ length: 51 }, (_, i) => `m${i}`) }).success).toBe(
      false,
    );
    expect(forget.safeParse({ scope, ids: [] }).success).toBe(false);
    expect(forget.safeParse({ scope, ids: ["../x"] }).success).toBe(false);
    expect(forget.safeParse({ scope, ids: ["m1"], extra: 1 }).success).toBe(false);
  });

  it("bounds a saved text and keeps `replaces` optional and safe", () => {
    const save = methods["memory.save"].params;
    const scope = { kind: "user" };
    expect(save.safeParse({ scope, text: "x".repeat(MEMORY_LIMITS.textChars) }).success).toBe(true);
    expect(save.safeParse({ scope, text: "x".repeat(MEMORY_LIMITS.textChars + 1) }).success).toBe(false);
    expect(save.safeParse({ scope, text: "" }).success).toBe(false);
    expect(save.safeParse({ scope, text: "a", replaces: "m:1" }).success).toBe(true);
    expect(save.safeParse({ scope, text: "a", replaces: "a/b" }).success).toBe(false);
  });

  it("decides by fact uuid and boolean", () => {
    const decide = methods["memory.decide"].params;
    expect(decide.safeParse({ factId, approved: true }).success).toBe(true);
    expect(decide.safeParse({ factId: "../x", approved: true }).success).toBe(false);
    expect(decide.safeParse({ factId, approved: "yes" }).success).toBe(false);
  });

  it("marks every staged fact untrusted", () => {
    const fact = {
      factId,
      agentId,
      text: "t",
      createdAt: "2026-10-16T00:00:00Z",
      decision: null,
      applying: false,
    };
    expect(StagedFactView.safeParse({ ...fact, untrusted: true }).success).toBe(true);
    expect(StagedFactView.safeParse({ ...fact, untrusted: false }).success).toBe(false);
    expect(StagedFactView.safeParse(fact).success).toBe(false);
  });

  it("tells an add from a forget in the journal, and keeps a memory's empty createdAt", () => {
    expect(MemoryJournalView.safeParse({ at: "t", kind: "add", text: "x", source: "agent" }).success).toBe(
      true,
    );
    expect(
      MemoryJournalView.safeParse({ at: "t", kind: "forget", text: "x", source: "pi-web" }).success,
    ).toBe(true);
    expect(MemoryJournalView.safeParse({ at: "t", kind: "other", text: "x", source: "s" }).success).toBe(
      false,
    );
    expect(MemoryJournalView.safeParse({ at: "t", text: "x" }).success).toBe(false);
    expect(MemoryItemView.safeParse({ id: "m1", text: "x", createdAt: "", source: "agent" }).success).toBe(
      true,
    );
  });

  it("labels the user scope with null: the client localizes by kind", () => {
    expect(MemoryScopeView.safeParse({ scope: { kind: "user" }, label: null }).success).toBe(true);
  });

  it("quarantine names the memory step last", () => {
    expect(QUARANTINE_STEPS.at(-1)).toBe("memory");
  });
});
