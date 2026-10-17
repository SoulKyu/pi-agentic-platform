import { type SubagentProfileFile } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createProfileReader } from "./profile.ts";

const profile: SubagentProfileFile = {
  name: "scout",
  description: "Scouts",
  source: "user",
  tools: ["read"],
  model: null,
  prompt: "Look.",
};

function bed(
  options: { trust?: boolean | null; cwd?: string | null; answer?: unknown; agent?: boolean } = {},
) {
  const runs: Array<{ op: string; params: unknown; options: { cwd?: string; deadlineMs: number } }> = [];
  const reader = createProfileReader({
    pi: {
      helpers: {
        run: vi.fn((op: string, params: unknown, opts: { cwd?: string; deadlineMs: number }) => {
          runs.push({ op, params, options: opts });
          return { done: Promise.resolve(options.answer ?? profile) };
        }),
      } as never,
      trust: { status: async () => (options.trust === undefined ? true : options.trust) },
    },
    sessions: {
      cwdOf: (ownerId, sessionId) =>
        ownerId === "u1" && sessionId === "s1" ? (options.cwd === undefined ? "/work/p" : options.cwd) : null,
      isAgentSession: () => options.agent === true,
    },
    logger: silentLogger,
  });
  return { reader, runs };
}

describe("reading one profile (Task 29b, carry 1)", () => {
  it("asks the helper for that name, offline, with the folder only while Pi trusts it", async () => {
    const trusted = bed();
    expect(await trusted.reader.get("u1", "s1", "scout")).toEqual(profile);
    expect(trusted.runs[0]).toMatchObject({
      op: "subagents.profile",
      params: { offline: true, name: "scout" },
      options: { cwd: "/work/p" },
    });
    for (const trust of [false, null]) {
      const other = bed({ trust });
      await other.reader.get("u1", "s1", "scout");
      expect(other.runs[0]?.options).not.toHaveProperty("cwd");
    }
  });

  it("never passes the folder for an agent's session, whatever Pi's trust says (W5-R27, W5-R29)", async () => {
    const { reader, runs } = bed({ trust: true, agent: true });
    await reader.get("u1", "s1", "scout");
    expect(runs[0]?.options).not.toHaveProperty("cwd");
  });

  it("is not_found for a session that is not the owner's, and asks nobody", async () => {
    const { reader, runs } = bed();
    await expect(reader.get("u2", "s1", "scout")).rejects.toMatchObject({ code: "not_found" });
    expect(runs).toEqual([]);
  });

  it("refuses an answer the contract does not accept, as helper_failed", async () => {
    const { reader } = bed({ answer: { ...profile, extra: 1 } });
    await expect(reader.get("u1", "s1", "scout")).rejects.toMatchObject({ code: "helper_failed" });
  });
});
